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

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2em; text-align: center; }
        h1 { color: #333; }
      </style>
    </head>
    <body>
      <h1>Welcome to HomeAItoB</h1>
      <p>Your document-integrated ai is ready to help!</p>
      <a href="/start">Get Started</a>
    </body>
    </html>
  `);
});

// Start route
app.get('/start', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Start</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2em; text-align: center; }
        h1 { color: #333; }
      </style>
    </head>
    <body>
      <h1>Help:</h1>
      <p>To use the assistant, enter your document ID in the URL.</p>
      <p>Example: www.homeaitob.org/start/ ** {document-ID} ** </p>
      <p></p>
      <p>Find your document ID by opening your document and copying the ID from the URL.</p>
      <p>https://docs.google.com/document/d/ ** {document-ID} ** /edit</p>
      <p></p>
      <p>Note: Will not work unless you are an approved user. </p>
      <p></p>
      <a href="/">Go Back Home</a>
    </body>
    </html>
  `);
});

// Routes
app.get('/start/:documentId', async (req, res) => {
  const documentId = req.params.documentId;
  if (!documentId) {
    return res.status(400).send('Missing document ID.');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Processing Document</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2em; text-align: center; }
        h1 { color: #333; }
      </style>
    </head>
    <body>
      <h1>Processing Document</h1>
      <p>Document ID: ${documentId}</p>
      <p>Processing your document. This may take a moment...</p>
      <a href="/">Go Back Home</a>
    </body>
    </html>
  `);
  try {
    // Check if the document owner is approved
    const approved = await isDocumentOwnerApproved(documentId);
    if (!approved) {
      console.log(`Document ${documentId} is not from an approved owner.`);
      return res.status(403).send('Document owner not approved for processing.');
    }

    console.log(`Starting processing for document: ${documentId}`);

    const document = await fetchDocument(documentId);
    const questions = parseQuestions(document);

    console.log(`Detected ${questions.length} question(s) in the document.`);

    for (const question of questions) {
      if (!question.answered) {
        console.log(`Processing question: "${question.text}"`);
        const answer = await generateAnswer(question.text);
        if (!answer) {
          console.log('No answer generated.');
          continue;
        }

        const insertIndex = document.body.content[question.index].endIndex - 1;
        const fullAnswer = `\n${answer}`;
        console.log(`Inserting answer at index ${insertIndex}`);
        await simulateTypingAndInsert(documentId, insertIndex, fullAnswer);
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Pause between questions
      }
    }

    console.log(`Finished processing document: ${documentId}`);

    // Ensure this is the only response sent to the client
    if (!res.headersSent) {
      res.send(`Processed document: ${documentId}`);
    }
  } catch (error) {
    console.error('Error processing document:', error);

    // Only send an error response if headers have not already been sent
    if (!res.headersSent) {
      res.status(500).send('Error processing document.');
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
