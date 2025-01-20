require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

// Instead of using destructured Configuration/OpenAIApi, directly require OpenAI.
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Initialize Google Docs API client using service account credentials.
const credentials = {
  client_email: process.env.CLIENT_EMAIL,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  token_uri: process.env.TOKEN_URI,
};

const SCOPES = ['https://www.googleapis.com/auth/documents'];

// Create a JWT client for Docs API
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: SCOPES,
  // Uncomment and modify the following if you need domain-wide delegation:
  // subject: 'user@yourdomain.com',
});

// Initialize Google Docs API
const docs = google.docs({ version: 'v1', auth });

// Initialize OpenAI API client using direct instantiation
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Fetch the full Google Document by documentId.
 */
async function fetchDocument(docId) {
  try {
    const res = await docs.documents.get({ documentId: docId });
    return res.data;
  } catch (error) {
    console.error('Error fetching document:', error);
    throw error;
  }
}

/**
 * Parse the document to find questions and check if they've been answered.
 * For simplicity, a question ends with '?' and an answer starts with 'Answer:'.
 */
function parseQuestions(document) {
  const content = document.body.content;
  const questions = [];

  for (let i = 0; i < content.length; i++) {
    const element = content[i];
    if (!element.paragraph) continue;

    const paraElements = element.paragraph.elements;
    if (!paraElements || paraElements.length === 0) continue;

    const textRun = paraElements[0].textRun;
    if (!textRun || !textRun.content) continue;

    const text = textRun.content.trim();
    if (text.endsWith('?')) {
      // Check if next paragraph starts with 'Answer:'
      const next = content[i + 1];
      let answered = false;
      if (
        next &&
        next.paragraph &&
        next.paragraph.elements &&
        next.paragraph.elements[0] &&
        next.paragraph.elements[0].textRun &&
        next.paragraph.elements[0].textRun.content.startsWith('Answer:')
      ) {
        answered = true;
      }
      questions.push({ text, index: i, answered });
    }
  }
  return questions;
}

/**
 * Use OpenAI to generate an answer for a given question.
 */
async function generateAnswer(questionText) {
  try {
    const response = await openai.createCompletion({
      model: 'text-davinci-003', // or another model as preferred
      prompt: `Answer the following question: ${questionText}`,
      max_tokens: 150,
    });
    // Adjust accessing response data based on library's response structure
    return response.data.choices[0].text.trim();
  } catch (error) {
    console.error('OpenAI error:', error);
    return null;
  }
}

/**
 * Simulate human-like typing to insert text into the document.
 */
async function simulateTypingAndInsert(docId, insertIndex, answerText) {
  const words = answerText.split(' ');

  for (let i = 0; i < words.length; i++) {
    const word = words[i] + (i < words.length - 1 ? ' ' : '');
    const requests = [
      {
        insertText: {
          location: { index: insertIndex },
          text: word,
        },
      },
    ];

    try {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
    } catch (error) {
      console.error('Error inserting text:', error);
      break;
    }

    insertIndex += word.length;

    const wordsPerMinute = 70 + Math.random() * 15;
    const delay = (60 / wordsPerMinute) * 1000;

    if (Math.random() < 0.1) {
      await new Promise((res) => setTimeout(res, delay * 5));
    } else {
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/**
 * Webhook route to process document.
 */
app.post('/webhook', async (req, res) => {
  const { documentId } = req.body;
  if (!documentId) return res.status(400).send('Missing documentId');

  try {
    const document = await fetchDocument(documentId);
    const questions = parseQuestions(document);

    for (const question of questions) {
      if (!question.answered) {
        const answer = await generateAnswer(question.text);
        if (!answer) continue;

        const insertIndex =
          document.body.content[question.index].endIndex - 1;
        const fullAnswer = `Answer: ${answer}\n`;
        await simulateTypingAndInsert(documentId, insertIndex, fullAnswer);
      }
    }
    res.send('Processed document.');
  } catch (error) {
    console.error('Error in /webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
