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
