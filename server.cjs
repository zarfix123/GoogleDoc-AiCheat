require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const processedDocs = new Set();
const app = express();
app.use(express.json());

// Approved Email List
const approvedEmails = [
  'zarfix.42@gmail.com',
  'dennis24.f@gmail.com',
  '26freymand@mbusdapps.org',
  ...(process.env.APPROVED_EMAILS ? process.env.APPROVED_EMAILS.split(',') : []) // Add emails from .env
];

// Initialize Google APIs
const credentials = {
  client_email: process.env.CLIENT_EMAIL,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  token_uri: process.env.TOKEN_URI,
};
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive'
];

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: SCOPES,
});

const docs = google.docs({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

// Utility Functions
async function fetchDocument(docId) {
  try {
    const res = await docs.documents.get({ documentId: docId });
    return res.data;
  } catch (error) {
    console.error(`Failed to fetch document ${docId}:`, error.response?.data || error.message);
    throw error;
  }
}

async function isDocumentOwnerApproved(docId) {
  try {
    // Fetch the file metadata, including the owners
    const res = await drive.files.get({
      fileId: docId,
      fields: 'owners(emailAddress, displayName)' // Fetch owner's name and email for better logging
    });

    const owners = res.data.owners || [];

    // Log all owners of the document for debugging
    console.log(`Owners of document ${docId}:`, owners.map((owner) => owner.emailAddress));

    // Check if any owner is in the approved email list
    const isApproved = owners.some((owner) =>
      approvedEmails.map((email) => email.toLowerCase()).includes(owner.emailAddress.toLowerCase())
    );

    if (!isApproved) {
      console.warn(
        `Document ${docId} has unapproved owners:`,
        owners.map((owner) => `${owner.displayName} <${owner.emailAddress}>`)
      );
    }

    return isApproved;
  } catch (error) {
    console.error('Error checking document owner:', error.response?.data || error.message);
    return false; // Default to not approved if an error occurs
  }
}


function parseQuestions(document) {
  const content = document.body.content || [];
  const questions = [];
  content.forEach((element, i) => {
    if (element.paragraph) {
      const textRun = element.paragraph.elements?.[0]?.textRun?.content?.trim();
      if (textRun && textRun.endsWith('?')) {
        const next = content[i + 1];
        const answered = next?.paragraph?.elements?.[0]?.textRun?.content?.startsWith('Answer:') || false;
        questions.push({ text: textRun, index: i, answered });
      }
    }
  });
  return questions;
}

async function generateAnswer(questionText) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that answers questions from provided context.' },
          { role: 'user', content: `Answer the following question: ${questionText}` }
        ],
        max_tokens: 150
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );
    return response.data.choices[0]?.message?.content?.trim();
  } catch (error) {
    console.error('Error calling OpenAI API:', error.response?.data || error.message);
    return null;
  }
}

async function simulateTypingAndInsert(docId, insertIndex, answerText) {
  const words = answerText.split(' ');
  const wordsPerMinute = 100 + Math.random() * 20; // Faster typing
  const delay = (60 / wordsPerMinute) * 1000;

  for (const [i, word] of words.entries()) {
    const text = word + (i < words.length - 1 ? ' ' : '');
    const requests = [{ insertText: { location: { index: insertIndex }, text } }];
    try {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
      insertIndex += text.length;
    } catch (error) {
      console.error('Error inserting text:', error.message);
      break;
    }
    await new Promise((res) => setTimeout(res, delay));
  }
}

// Routes
app.get('/start/:documentId', async (req, res) => {
  const documentId = req.params.documentId;
  if (!documentId) return res.status(400).send('Missing document ID.');

  if (!await isDocumentOwnerApproved(documentId)) {
    return res.status(403).send('Document owner not approved.');
  }

  try {
    const document = await fetchDocument(documentId);
    const questions = parseQuestions(document);
    console.log(`Detected ${questions.length} questions in document ${documentId}`);

    for (const question of questions) {
      if (!question.answered) {
        const answer = await generateAnswer(question.text);
        if (answer) {
          const insertIndex = document.body.content[question.index].endIndex - 1;
          await simulateTypingAndInsert(documentId, insertIndex, `\n${answer}`);
          await new Promise((res) => setTimeout(res, 2000)); // Delay between questions
        }
      }
    }
    res.send(`Processed document: ${documentId}`);
  } catch (error) {
    console.error('Error processing document:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
