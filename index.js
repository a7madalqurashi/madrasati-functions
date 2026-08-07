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

function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function verifyAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing auth token.' });
    return null;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Invalid auth token.' });
    return null;
  }
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('generateQuestions service is running.');
});

app.post('/generateQuestions', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

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

app.post('/deleteAttempt', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const examId = req.body && req.body.examId;
  const attemptId = req.body && req.body.attemptId;
  if (!examId || !attemptId) {
    res.status(400).json({ error: 'examId and attemptId are required.' });
    return;
  }

  const examRef = db.collection('exams').doc(examId);
  const examSnap = await examRef.get();
  if (!examSnap.exists) {
    res.status(404).json({ error: 'Exam not found.' });
    return;
  }
  if (examSnap.data().teacherId !== uid) {
    res.status(403).json({ error: 'Not the owner of this exam.' });
    return;
  }

  const attemptRef = examRef.collection('attempts').doc(attemptId);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) {
    res.status(404).json({ error: 'Attempt not found.' });
    return;
  }
  const studentUid = attemptSnap.data().studentUid;

  await attemptRef.delete();
  if (studentUid) {
    await db.collection('studentAttempts').doc(studentUid).collection('records').doc(attemptId).delete();
  }

  res.status(200).json({ success: true });
});

app.post('/publishExam', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

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

  const questionsSnap = await examRef.collection('questions').limit(1).get();
  if (questionsSnap.empty) {
    res.status(400).json({ error: 'Exam has no questions yet.' });
    return;
  }

  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateJoinCode();
    const existing = await db.collection('joinCodes').doc(candidate).get();
    if (!existing.exists) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    res.status(500).json({ error: 'Could not generate a unique join code, try again.' });
    return;
  }

  await db.collection('joinCodes').doc(code).set({ examId, active: true });
  await examRef.update({
    status: 'published',
    joinCode: code,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.status(200).json({ joinCode: code });
});

app.post('/examReport', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

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

  const attemptsSnap = await examRef.collection('attempts').where('status', '==', 'submitted').get();
  const rows = [];
  for (const doc of attemptsSnap.docs) {
    const a = doc.data();
    let nationalId = '';
    if (a.studentUid) {
      const userSnap = await db.collection('users').doc(a.studentUid).get();
      if (userSnap.exists) nationalId = userSnap.data().nationalId || '';
    }
    rows.push({
      studentName: a.studentDisplayName || '',
      nationalId,
      score: a.score || 0,
      totalPoints: a.totalPoints || 0,
    });
  }
  rows.sort((x, y) => x.studentName.localeCompare(y.studentName, 'ar'));

  res.status(200).json({
    examTitle: exam.title || '',
    subject: exam.subject || '',
    rows,
  });
});

app.post('/searchStudents', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const query = ((req.body && req.body.query) || '').trim().toLowerCase();
  if (query.length < 2) {
    res.status(200).json({ students: [] });
    return;
  }

  const usersSnap = await db.collection('users').where('role', '==', 'student').get();
  const students = [];
  usersSnap.forEach((doc) => {
    const u = doc.data();
    const name = [u.firstName, u.fatherName, u.lastName].filter(Boolean).join(' ');
    const phone = u.phone || '';
    if (name.toLowerCase().includes(query) || phone.includes(query)) {
      students.push({ uid: doc.id, name, phone });
    }
  });

  res.status(200).json({ students: students.slice(0, 20) });
});

app.post('/startExamAttempt', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const joinCode = (req.body && req.body.joinCode || '').toUpperCase().trim();
  const displayName = (req.body && req.body.displayName || '').trim();
  if (!joinCode) {
    res.status(400).json({ error: 'joinCode is required.' });
    return;
  }

  const codeSnap = await db.collection('joinCodes').doc(joinCode).get();
  if (!codeSnap.exists || !codeSnap.data().active) {
    res.status(404).json({ error: 'Invalid or inactive join code.' });
    return;
  }
  const examId = codeSnap.data().examId;
  const examRef = db.collection('exams').doc(examId);
  const examSnap = await examRef.get();
  if (!examSnap.exists || examSnap.data().status !== 'published') {
    res.status(404).json({ error: 'This exam is not available.' });
    return;
  }
  const exam = examSnap.data();

  if (exam.restrictedStudentUid && exam.restrictedStudentUid !== uid) {
    res.status(403).json({
      error: 'This exam is restricted to a specific student.',
      restricted: true,
    });
    return;
  }

  const attemptsAllowed = (exam.settings && exam.settings.attemptsAllowed) || 1;
  const priorAttempts = await examRef
    .collection('attempts')
    .where('studentUid', '==', uid)
    .get();
  if (priorAttempts.size >= attemptsAllowed) {
    res.status(403).json({ error: 'You have no attempts left for this exam.' });
    return;
  }

  const questionsSnap = await examRef.collection('questions').orderBy('order').get();
  const questions = questionsSnap.docs.map((d) => {
    const q = d.data();
    return {
      id: d.id,
      type: q.type,
      text: q.text,
      options: q.options || null,
      optionImageUrls: q.optionImageUrls || null,
      points: q.points || 1,
    };
  });

  // Shuffle question order per attempt so students sitting together see a
  // different sequence — grading is keyed by question id, unaffected by order.
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }

  const attemptRef = await examRef.collection('attempts').add({
    studentUid: uid,
    studentDisplayName: displayName,
    status: 'in_progress',
    answers: {},
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let watermarkText = displayName;
  const userSnap = await db.collection('users').doc(uid).get();
  if (userSnap.exists && userSnap.data().nationalId) {
    watermarkText = `${displayName} - ${userSnap.data().nationalId}`;
  }

  res.status(200).json({
    attemptId: attemptRef.id,
    examId,
    examTitle: exam.title,
    subject: exam.subject,
    teacherWhatsApp: exam.teacherWhatsApp || null,
    timeLimitMinutes: (exam.settings && exam.settings.timeLimitMinutes) || null,
    watermarkText,
    questions,
  });
});

app.post('/submitExamAttempt', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const examId = req.body && req.body.examId;
  const attemptId = req.body && req.body.attemptId;
  const answers = (req.body && req.body.answers) || {};
  const tabSwitchCount = Math.max(0, Math.min(999, Number(req.body && req.body.tabSwitchCount) || 0));
  if (!examId || !attemptId) {
    res.status(400).json({ error: 'examId and attemptId are required.' });
    return;
  }

  const examRef = db.collection('exams').doc(examId);
  const attemptRef = examRef.collection('attempts').doc(attemptId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const attemptSnap = await tx.get(attemptRef);
      if (!attemptSnap.exists) {
        throw { httpStatus: 404, message: 'Attempt not found.' };
      }
      const attempt = attemptSnap.data();
      if (attempt.studentUid !== uid) {
        throw { httpStatus: 403, message: 'Not your attempt.' };
      }

      const examSnap = await tx.get(examRef);
      const exam = examSnap.data() || {};
      const showResult = exam.showResultToStudent !== false;

      if (attempt.status === 'submitted') {
        // Already graded — immutable. Return the existing score instead of
        // re-grading, so a duplicate submit can never change the result.
        return showResult
          ? { score: attempt.score, totalPoints: attempt.totalPoints, alreadySubmitted: true }
          : { hidden: true, alreadySubmitted: true };
      }

      const questionsSnap = await tx.get(examRef.collection('questions'));
      let score = 0;
      let totalPoints = 0;
      questionsSnap.docs.forEach((qDoc) => {
        const q = qDoc.data();
        const points = q.points || 1;
        totalPoints += points;
        const studentAnswer = answers[qDoc.id];
        if (studentAnswer !== undefined && studentAnswer === q.correctAnswer) {
          score += points;
        }
      });

      const submittedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.update(attemptRef, {
        answers,
        score,
        totalPoints,
        tabSwitchCount,
        status: 'submitted',
        submittedAt,
      });
      tx.set(
        db.collection('studentAttempts').doc(uid).collection('records').doc(attemptId),
        {
          examId,
          examTitle: exam.title || '',
          subject: exam.subject || '',
          hidden: !showResult,
          ...(showResult ? { score, totalPoints } : {}),
          submittedAt,
        }
      );

      return showResult
        ? { score, totalPoints, alreadySubmitted: false }
        : { hidden: true, alreadySubmitted: false };
    });

    res.status(200).json(result);
  } catch (error) {
    const status = error.httpStatus || 500;
    res.status(status).json({ error: error.message || 'Submission failed.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`generateQuestions service listening on port ${port}`);
});
