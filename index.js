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
  if (!exam.sourceFile || !exam.sourceFile.url) {
    res.status(400).json({ error: 'Exam has no uploaded curriculum file.' });
    return;
  }

  const difficulty = DIFFICULTIES.includes(exam.difficulty) ? exam.difficulty : 'beginner';
  const trueFalseCount = (exam.requestedCounts && exam.requestedCounts.trueFalse) || 0;
  const multipleChoiceCount = (exam.requestedCounts && exam.requestedCounts.multipleChoice) || 0;
  const language = exam.language === 'en' ? 'en' : 'ar';

  await examRef.update({ status: 'generating' });

  try {
    const fileResponse = await fetch(exam.sourceFile.url);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download curriculum file (${fileResponse.status}).`);
    }
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
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

app.post('/copySharedExam', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const examId = req.body && req.body.examId;
  if (!examId) {
    res.status(400).json({ error: 'examId is required.' });
    return;
  }

  const sourceRef = db.collection('exams').doc(examId);
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) {
    res.status(404).json({ error: 'Exam not found.' });
    return;
  }
  const source = sourceSnap.data();
  const isPublic = source.sharedToLibrary === true;
  const isSharedWithMe =
    Array.isArray(source.sharedWithTeacherUids) && source.sharedWithTeacherUids.includes(uid);
  if (source.status !== 'published' || (!isPublic && !isSharedWithMe)) {
    res.status(403).json({ error: 'This exam is not shared with you.' });
    return;
  }

  const questionsSnap = await sourceRef.collection('questions').orderBy('order').get();

  let teacherWhatsApp = '';
  const userSnap = await db.collection('users').doc(uid).get();
  if (userSnap.exists) teacherWhatsApp = userSnap.data().whatsappNumber || '';

  const newExamRef = db.collection('exams').doc();
  await newExamRef.set({
    teacherId: uid,
    title: source.title || '',
    subject: source.subject || '',
    stage: source.stage || '',
    sections: source.sections || [],
    schoolName: source.schoolName || '',
    schoolNumber: source.schoolNumber || '',
    language: source.language || 'ar',
    difficulty: source.difficulty || 'beginner',
    status: 'review',
    requestedCounts: source.requestedCounts || { trueFalse: 0, multipleChoice: 0 },
    generatedCounts: source.generatedCounts || { trueFalse: 0, multipleChoice: 0 },
    teacherWhatsApp,
    totalPoints: source.totalPoints || 0,
    showResultToStudent: true,
    sharedToLibrary: false,
    teacherDisplayName: '',
    settings: { attemptsAllowed: 1 },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const batch = db.batch();
  questionsSnap.docs.forEach((doc) => {
    const q = doc.data();
    const qRef = newExamRef.collection('questions').doc();
    batch.set(qRef, {
      type: q.type,
      text: q.text,
      options: q.options || null,
      optionImageUrls: q.optionImageUrls || null,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation || null,
      order: q.order || 0,
      source: q.source || 'manual',
      points: q.points || 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();

  res.status(200).json({ examId: newExamRef.id });
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

  try {
    let tokens = [];
    if (exam.restrictedStudentUid) {
      const studentSnap = await db.collection('users').doc(exam.restrictedStudentUid).get();
      tokens = studentSnap.exists ? (studentSnap.data().fcmTokens || []) : [];
    } else {
      tokens = await getStudentTokens({ schoolNumber: exam.schoolNumber, stage: exam.stage });
    }
    await sendPushToTokens(tokens, {
      title: 'اختبار جديد',
      body: `تم نشر اختبار "${exam.title || exam.subject}" — انضم الآن`,
      data: { type: 'exam_published', examId },
    });
  } catch (e) {
    console.error('publishExam notification failed:', e);
  }
});

// Sends a push notification to a list of FCM tokens, silently dropping any
// tokens Firebase reports as no-longer-valid (uninstalled app, stale web
// session, etc.) so they stop being retried on future sends.
async function sendPushToTokens(tokens, { title, body, data }) {
  const uniqueTokens = [...new Set(tokens)].filter(Boolean);
  if (uniqueTokens.length === 0) return;

  const response = await admin.messaging().sendEachForMulticast({
    tokens: uniqueTokens,
    notification: { title, body },
    data: data || {},
  });

  const deadTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-argument'].includes(r.error?.code)) {
      deadTokens.push(uniqueTokens[i]);
    }
  });
  if (deadTokens.length > 0) {
    const usersSnap = await db.collection('users').where('fcmTokens', 'array-contains-any', deadTokens.slice(0, 10)).get();
    await Promise.all(
      usersSnap.docs.map((doc) =>
        doc.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...deadTokens) })
      )
    );
  }
}

// Collects the FCM tokens of every student matching a school + stage (and,
// if given, a specific section within it) — used to notify a whole class or
// stage about a new exam/homework without needing a dedicated audience list.
async function getStudentTokens({ schoolNumber, stage, sections }) {
  let query = db.collection('users')
    .where('role', '==', 'student')
    .where('schoolNumber', '==', schoolNumber)
    .where('stage', '==', stage);
  const snap = await query.get();
  const tokens = [];
  snap.forEach((doc) => {
    const u = doc.data();
    if (sections && sections.length > 0 && !sections.includes(u.section)) return;
    if (Array.isArray(u.fcmTokens)) tokens.push(...u.fcmTokens);
  });
  return tokens;
}

async function commitInChunks(docRefsWithData) {
  for (let i = 0; i < docRefsWithData.length; i += 450) {
    const batch = db.batch();
    docRefsWithData.slice(i, i + 450).forEach(({ ref, data, merge }) => {
      batch.set(ref, data, merge ? { merge: true } : {});
    });
    await batch.commit();
  }
}

// Toggles whether an already-published exam is currently joinable. Closing
// it also permanently reveals results to every student who already
// submitted, regardless of the per-exam showResultToStudent setting — the
// close action is the teacher's explicit "the exam is over" signal.
app.post('/setExamPublishStatus', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const examId = req.body && req.body.examId;
  const publish = req.body && req.body.publish;
  if (!examId || typeof publish !== 'boolean') {
    res.status(400).json({ error: 'examId and publish (boolean) are required.' });
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
  if (exam.status !== 'published' && exam.status !== 'closed') {
    res.status(400).json({ error: 'Exam must be published before its availability can be toggled.' });
    return;
  }

  await examRef.update({
    status: publish ? 'published' : 'closed',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  if (exam.joinCode) {
    await db.collection('joinCodes').doc(exam.joinCode).set({ active: publish }, { merge: true });
  }

  let revealedCount = 0;
  let revealedStudentUids = [];
  if (!publish) {
    const attemptsSnap = await examRef.collection('attempts').where('status', '==', 'submitted').get();
    const updates = attemptsSnap.docs.map((doc) => {
      const attempt = doc.data();
      revealedCount += 1;
      revealedStudentUids.push(attempt.studentUid);
      return {
        ref: db.collection('studentAttempts').doc(attempt.studentUid).collection('records').doc(doc.id),
        data: { hidden: false, score: attempt.score, totalPoints: attempt.totalPoints },
        merge: true,
      };
    });
    await commitInChunks(updates);
  }

  res.status(200).json({ status: publish ? 'published' : 'closed', revealedCount });

  if (revealedStudentUids.length > 0) {
    try {
      const usersSnap = await db.getAll(
        ...revealedStudentUids.map((sUid) => db.collection('users').doc(sUid))
      );
      const tokens = usersSnap.flatMap((doc) => (doc.exists ? doc.data().fcmTokens || [] : []));
      await sendPushToTokens(tokens, {
        title: 'نتيجتك جاهزة',
        body: `ظهرت نتيجتك في اختبار "${exam.title || exam.subject}"`,
        data: { type: 'result_ready', examId },
      });
    } catch (e) {
      console.error('setExamPublishStatus notification failed:', e);
    }
  }
});

// Detaches students from the caller's school (clears schoolNumber/stage/section)
// without touching their account, login, or exam history — fully reversible via
// re-import or re-entering the info from the student's profile.
app.post('/removeStudentsFromSchool', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const callerSnap = await db.collection('users').doc(uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== 'teacher') {
    res.status(403).json({ error: 'Only teachers can perform this action.' });
    return;
  }
  const callerSchool = String(callerSnap.data().schoolNumber || '').trim();
  if (!callerSchool) {
    res.status(400).json({ error: 'Your account has no school number set.' });
    return;
  }

  const scope = req.body && req.body.scope;
  const studentUid = req.body && req.body.studentUid;
  const stage = req.body && req.body.stage;
  const section = req.body && req.body.section;

  const clearedFields = {
    schoolNumber: admin.firestore.FieldValue.delete(),
    stage: admin.firestore.FieldValue.delete(),
    section: admin.firestore.FieldValue.delete(),
  };

  if (scope === 'student') {
    if (!studentUid) {
      res.status(400).json({ error: 'studentUid is required.' });
      return;
    }
    const targetRef = db.collection('users').doc(studentUid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists || targetSnap.data().schoolNumber !== callerSchool) {
      res.status(404).json({ error: 'Student not found in your school.' });
      return;
    }
    await targetRef.update(clearedFields);
    res.status(200).json({ removedCount: 1 });
    return;
  }

  let query = db
    .collection('users')
    .where('role', '==', 'student')
    .where('schoolNumber', '==', callerSchool);

  if (scope === 'stage') {
    if (!stage) {
      res.status(400).json({ error: 'stage is required.' });
      return;
    }
    query = query.where('stage', '==', stage);
  } else if (scope === 'section') {
    if (!stage || section === undefined || section === null) {
      res.status(400).json({ error: 'stage and section are required.' });
      return;
    }
    query = query.where('stage', '==', stage).where('section', '==', section);
  } else {
    res.status(400).json({ error: 'Invalid scope.' });
    return;
  }

  const snap = await query.get();
  await commitInChunks(snap.docs.map((doc) => ({ ref: doc.ref, data: clearedFields, merge: true })));

  res.status(200).json({ removedCount: snap.size });
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

app.post('/studentReports', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const examsSnap = await db.collection('exams').where('teacherId', '==', uid).get();
  const byStudent = new Map();

  for (const examDoc of examsSnap.docs) {
    const exam = examDoc.data();
    const attemptsSnap = await examDoc.ref.collection('attempts').where('status', '==', 'submitted').get();
    attemptsSnap.forEach((a) => {
      const data = a.data();
      if (!data.studentUid) return;
      const entry = byStudent.get(data.studentUid) || {
        studentUid: data.studentUid,
        name: data.studentDisplayName || '',
        attempts: [],
      };
      entry.attempts.push({
        examId: examDoc.id,
        examTitle: exam.title || '',
        subject: exam.subject || '',
        score: data.score || 0,
        totalPoints: data.totalPoints || 0,
      });
      byStudent.set(data.studentUid, entry);
    });
  }

  const students = [];
  for (const entry of byStudent.values()) {
    let stage = '';
    let section = null;
    let phone = '';
    const userSnap = await db.collection('users').doc(entry.studentUid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      stage = u.stage || '';
      section = u.section != null ? u.section : null;
      phone = u.phone || '';
      if (u.firstName) {
        entry.name = [u.firstName, u.fatherName, u.lastName].filter(Boolean).join(' ');
      }
    }
    const totalScore = entry.attempts.reduce((s, a) => s + a.score, 0);
    const totalPossible = entry.attempts.reduce((s, a) => s + a.totalPoints, 0);
    students.push({
      uid: entry.studentUid,
      name: entry.name,
      phone,
      stage,
      section,
      examCount: entry.attempts.length,
      totalScore,
      totalPossible,
      attempts: entry.attempts,
    });
  }

  res.status(200).json({ students });
});

app.post('/importStudents', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const rows = (req.body && req.body.students) || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'No student rows provided.' });
    return;
  }

  let created = 0;
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    const nationalId = String(row.nationalId || '').replace(/\D/g, '');
    const phone = String(row.phone || '').replace(/\D/g, '') || nationalId;
    const firstName = String(row.firstName || '').trim();
    const fatherName = String(row.fatherName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const stage = String(row.stage || '').trim();
    const schoolName = String(row.schoolName || '').trim();
    const schoolNumber = String(row.schoolNumber || '').trim();
    const sectionNum = parseInt(row.section, 10);

    if (!nationalId || !phone || !firstName) {
      failed.push({ phone, reason: 'Missing required fields.' });
      continue;
    }

    const existing = await db.collection('loginLookup').doc(phone).get();
    if (existing.exists) {
      skipped.push({ phone, reason: 'Phone already registered.' });
      continue;
    }

    const password = nationalId.slice(-6).padStart(6, '0');
    const authEmail = `${phone}@madrasati.local`;

    try {
      const userRecord = await admin.auth().createUser({
        email: authEmail,
        password,
      });
      await db.collection('users').doc(userRecord.uid).set({
        role: 'student',
        nationalId,
        firstName,
        fatherName,
        lastName,
        email: '',
        phone,
        schoolName,
        schoolNumber,
        stage,
        section: isNaN(sectionNum) ? null : sectionNum,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection('loginLookup').doc(phone).set({ email: authEmail });
      created++;
    } catch (error) {
      failed.push({ phone, reason: String(error.message || error) });
    }
  }

  res.status(200).json({ created, skipped, failed });
});

app.post('/searchTeachers', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const query = ((req.body && req.body.query) || '').trim().toLowerCase();
  if (query.length < 2) {
    res.status(200).json({ teachers: [] });
    return;
  }

  const usersSnap = await db.collection('users').where('role', '==', 'teacher').get();
  const teachers = [];
  usersSnap.forEach((doc) => {
    if (doc.id === uid) return;
    const u = doc.data();
    const name = [u.firstName, u.fatherName, u.lastName].filter(Boolean).join(' ');
    const phone = u.phone || '';
    const email = (u.email || '').toLowerCase();
    if (name.toLowerCase().includes(query) || phone.includes(query) || email.includes(query)) {
      teachers.push({ uid: doc.id, name, phone });
    }
  });

  res.status(200).json({ teachers: teachers.slice(0, 20) });
});

app.post('/sendFriendRequest', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const toUid = ((req.body && req.body.toUid) || '').trim();
  if (!toUid || toUid === uid) {
    res.status(400).json({ error: 'Invalid recipient.' });
    return;
  }

  const [fromDoc, toDoc] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('users').doc(toUid).get(),
  ]);
  if (!toDoc.exists) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const fromData = fromDoc.data() || {};
  const toData = toDoc.data();
  const fromName = [fromData.firstName, fromData.fatherName, fromData.lastName].filter(Boolean).join(' ');
  const toName = [toData.firstName, toData.fatherName, toData.lastName].filter(Boolean).join(' ');

  if ((fromData.friendUids || []).includes(toUid)) {
    res.status(200).json({ status: 'already_friends' });
    return;
  }

  const reverseId = `${toUid}_${uid}`;
  const reverseDoc = await db.collection('friendRequests').doc(reverseId).get();
  if (reverseDoc.exists && reverseDoc.data().status === 'pending') {
    await db.runTransaction(async (tx) => {
      tx.update(db.collection('users').doc(uid), {
        friendUids: admin.firestore.FieldValue.arrayUnion(toUid),
        [`friendNames.${toUid}`]: toName,
      });
      tx.update(db.collection('users').doc(toUid), {
        friendUids: admin.firestore.FieldValue.arrayUnion(uid),
        [`friendNames.${uid}`]: fromName,
      });
      tx.delete(db.collection('friendRequests').doc(reverseId));
    });
    res.status(200).json({ status: 'accepted' });
    return;
  }

  const requestId = `${uid}_${toUid}`;
  await db.collection('friendRequests').doc(requestId).set({
    fromUid: uid,
    fromName,
    toUid,
    toName,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.status(200).json({ status: 'sent' });
});

app.post('/respondFriendRequest', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const requestId = ((req.body && req.body.requestId) || '').trim();
  const accept = !!(req.body && req.body.accept);

  const reqRef = db.collection('friendRequests').doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) {
    res.status(404).json({ error: 'Request not found.' });
    return;
  }
  const data = reqDoc.data();
  if (data.toUid !== uid) {
    res.status(403).json({ error: 'Not authorized.' });
    return;
  }

  if (accept) {
    await db.runTransaction(async (tx) => {
      tx.update(db.collection('users').doc(data.fromUid), {
        friendUids: admin.firestore.FieldValue.arrayUnion(data.toUid),
        [`friendNames.${data.toUid}`]: data.toName,
      });
      tx.update(db.collection('users').doc(data.toUid), {
        friendUids: admin.firestore.FieldValue.arrayUnion(data.fromUid),
        [`friendNames.${data.fromUid}`]: data.fromName,
      });
      tx.delete(reqRef);
    });
  } else {
    await reqRef.delete();
  }

  res.status(200).json({ status: accept ? 'accepted' : 'rejected' });
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

  const now = Date.now();
  if (exam.scheduledStartAt && now < exam.scheduledStartAt) {
    res.status(403).json({
      error: 'This exam has not started yet.',
      notStarted: true,
      scheduledStartAt: exam.scheduledStartAt,
    });
    return;
  }
  if (exam.scheduledEndAt && now > exam.scheduledEndAt) {
    res.status(403).json({
      error: 'This exam has ended.',
      ended: true,
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
  // For each shuffled multiple-choice question, optionOrder[questionId] holds
  // the original index that now sits at each shuffled position — e.g. [2,0,1]
  // means "shuffled option 0 is original option 2", etc. Stored on the
  // attempt (server-side) so both grading and the teacher's answer review can
  // translate a student's shuffled-position answer back to the source option.
  const optionOrder = {};
  const questions = questionsSnap.docs.map((d) => {
    const q = d.data();
    let options = q.options || null;
    let optionImageUrls = q.optionImageUrls || null;

    if (q.type === 'multiple_choice' && Array.isArray(options) && options.length > 1) {
      const order = options.map((_, idx) => idx);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      options = order.map((originalIdx) => options[originalIdx]);
      if (Array.isArray(optionImageUrls)) {
        optionImageUrls = order.map((originalIdx) => optionImageUrls[originalIdx] ?? null);
      }
      optionOrder[d.id] = order;
    }

    return {
      id: d.id,
      type: q.type,
      text: q.text,
      options,
      optionImageUrls,
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
    optionOrder,
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
      const optionOrder = attempt.optionOrder || {};
      let score = 0;
      let totalPoints = 0;
      questionsSnap.docs.forEach((qDoc) => {
        const q = qDoc.data();
        const points = q.points || 1;
        totalPoints += points;
        const studentAnswer = answers[qDoc.id];
        // Options were shuffled per attempt, so the correct shuffled
        // position for this student is derived from the order stored on
        // their attempt, not the question's original correctAnswer index
        // (falls back to it for older attempts with no stored order).
        const order = optionOrder[qDoc.id];
        const correctAnswer = order ? order.indexOf(q.correctAnswer) : q.correctAnswer;
        if (studentAnswer !== undefined && studentAnswer === correctAnswer) {
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

// The client creates the homework doc directly in Firestore, then calls this
// to fan out a push notification — there's no Firestore-trigger layer on
// this Express/Render backend, so notifications are always client-initiated.
app.post('/notifyHomeworkCreated', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const homeworkId = req.body && req.body.homeworkId;
  if (!homeworkId) {
    res.status(400).json({ error: 'homeworkId is required.' });
    return;
  }

  const homeworkSnap = await db.collection('homework').doc(homeworkId).get();
  if (!homeworkSnap.exists) {
    res.status(404).json({ error: 'Homework not found.' });
    return;
  }
  const homework = homeworkSnap.data();
  if (homework.teacherId !== uid) {
    res.status(403).json({ error: 'Not the owner of this homework.' });
    return;
  }

  res.status(200).json({ ok: true });

  try {
    const teacherSnap = await db.collection('users').doc(uid).get();
    const schoolNumber = teacherSnap.exists ? teacherSnap.data().schoolNumber : '';
    const tokens = await getStudentTokens({
      schoolNumber,
      stage: homework.stage,
      sections: homework.sections,
    });
    await sendPushToTokens(tokens, {
      title: 'واجب جديد',
      body: `تم إضافة واجب جديد: "${homework.title}"`,
      data: { type: 'homework_created', homeworkId },
    });
  } catch (e) {
    console.error('notifyHomeworkCreated failed:', e);
  }
});

app.post('/notifyHomeworkSubmitted', async (req, res) => {
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const homeworkId = req.body && req.body.homeworkId;
  if (!homeworkId) {
    res.status(400).json({ error: 'homeworkId is required.' });
    return;
  }

  const homeworkSnap = await db.collection('homework').doc(homeworkId).get();
  if (!homeworkSnap.exists) {
    res.status(404).json({ error: 'Homework not found.' });
    return;
  }
  const homework = homeworkSnap.data();

  res.status(200).json({ ok: true });

  try {
    const teacherSnap = await db.collection('users').doc(homework.teacherId).get();
    const tokens = teacherSnap.exists ? teacherSnap.data().fcmTokens || [] : [];
    await sendPushToTokens(tokens, {
      title: 'تسليم واجب جديد',
      body: `تم تسليم واجب "${homework.title}"`,
      data: { type: 'homework_submitted', homeworkId },
    });
  } catch (e) {
    console.error('notifyHomeworkSubmitted failed:', e);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`generateQuestions service listening on port ${port}`);
});
