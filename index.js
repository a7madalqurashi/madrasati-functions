const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const MAX_CHARS = 40000;
const DIFFICULTIES = ['beginner', 'intermediate', 'hard'];

async function extractText(buffer, mimeType) {
  let raw;
  if (mimeType === 'application/pdf') {
    raw = (await pdfParse(buffer)).text;
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    raw = (await mammoth.extractRawText({ buffer })).value;
  } else {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }
  const trimmed = raw.trim();
  return trimmed.length <= MAX_CHARS ? trimmed : trimmed.slice(0, MAX_CHARS);
}

function buildPrompt({ text, difficulty, trueFalseCount, multipleChoiceCount, language }) {
  const languageName = language === 'ar' ? 'Arabic' : 'English';
  return `You are an expert teacher creating an exam from the curriculum text below.

Curriculum text:
"""
${text}
"""

Generate exactly ${trueFalseCount} true/false questions and ${multipleChoiceCount} multiple-choice questions (3-4 options each) at "${difficulty}" difficulty.
Write all question text, options, and explanations in ${languageName}.
Base every question strictly on the curriculum text above. Use the submit_questions tool to return your answer.`;
}

const questionTool = {
  name: 'submit_questions',
  description: 'Submit the generated exam questions',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['true_false', 'multiple_choice'] },
            text: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            correctAnswer: {},
            explanation: { type: 'string' },
          },
          required: ['type', 'text', 'correctAnswer'],
        },
      },
    },
    required: ['questions'],
  },
};

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('No questions returned.');
  }
  for (const q of questions) {
    if (q.type !== 'true_false' && q.type !== 'multiple_choice') {
      throw new Error(`Invalid question type: ${q.type}`);
    }
    if (typeof q.text !== 'string' || q.text.trim().length === 0) {
      throw new Error('Question text missing.');
    }
    if (q.type === 'true_false' && typeof q.correctAnswer !== 'boolean') {
      throw new Error('true_false correctAnswer must be boolean.');
    }
    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 5) {
        throw new Error('multiple_choice needs 3-5 options.');
      }
      if (
        typeof q.correctAnswer !== 'number' ||
        q.correctAnswer < 0 ||
        q.correctAnswer >= q.options.length
      ) {
        throw new Error('multiple_choice correctAnswer must be a valid option index.');
      }
    }
  }
}

async function callClaude(anthropic, prompt, retryNote) {
  const messages = [{ role: 'user', content: retryNote ? `${prompt}\n\n${retryNote}` : prompt }];
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    tools: [questionTool],
    tool_choice: { type: 'tool', name: 'submit_questions' },
    messages,
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not return a tool_use block.');
  return toolUse.input.questions;
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('generateQuestions service is running.');
});

app.post('/generateQuestions', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing auth token.' });
    return;
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Invalid auth token.' });
    return;
  }

  const examId = req.body && req.body.examId;
  if (!examId) {
    res.status(400).json({ error: 'examId is required.' });
    return;
  }

  const examRef = db.collection('exams').doc(examId);
  const examSnap = await examRef.get();
  if (!examSnap.exists) {
    res.status(404).json({ error: 'Exam not found.' });
    return;
  }
  const exam = examSnap.data();
  if (exam.teacherId !== uid) {
    res.status(403).json({ error: 'Not the owner of this exam.' });
    return;
  }
  if (!exam.sourceFile || !exam.sourceFile.storagePath) {
    res.status(400).json({ error: 'Exam has no uploaded curriculum file.' });
    return;
  }

  const difficulty = DIFFICULTIES.includes(exam.difficulty) ? exam.difficulty : 'beginner';
  const trueFalseCount = (exam.requestedCounts && exam.requestedCounts.trueFalse) || 0;
  const multipleChoiceCount = (exam.requestedCounts && exam.requestedCounts.multipleChoice) || 0;
  const language = exam.language === 'en' ? 'en' : 'ar';

  await examRef.update({ status: 'generating' });

  try {
    const [fileBuffer] = await bucket.file(exam.sourceFile.storagePath).download();
    const text = await extractText(fileBuffer, exam.sourceFile.mimeType);
    const prompt = buildPrompt({ text, difficulty, trueFalseCount, multipleChoiceCount, language });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let questions;
    try {
      questions = await callClaude(anthropic, prompt);
      validateQuestions(questions);
    } catch (firstError) {
      questions = await callClaude(
        anthropic,
        prompt,
        `Your previous response was invalid: ${firstError.message}. Please call submit_questions again with a valid, complete list of questions.`
      );
      validateQuestions(questions);
    }

    const batch = db.batch();
    let tfCount = 0;
    let mcqCount = 0;
    questions.forEach((q, index) => {
      const qRef = examRef.collection('questions').doc();
      batch.set(qRef, {
        type: q.type,
        text: q.text,
        options: q.options || null,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        difficulty,
        order: index,
        source: 'ai',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (q.type === 'true_false') tfCount++;
      else mcqCount++;
    });
    await batch.commit();

    await examRef.update({
      status: 'review',
      generatedCounts: { trueFalse: tfCount, multipleChoice: mcqCount },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ success: true, trueFalse: tfCount, multipleChoice: mcqCount });
  } catch (error) {
    await examRef.update({
      status: 'draft',
      generationError: String(error.message || error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: 'Question generation failed.', details: String(error.message || error) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`generateQuestions service listening on port ${port}`);
});
