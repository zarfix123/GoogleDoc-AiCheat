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

// New Function: Detect Questions using OpenAI
async function detectQuestions(documentText) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an assistant that extracts all unique questions from the provided text.'
          },
          {
            role: 'user',
            content: `Extract all the unique questions from the following document text. Provide them as a JSON array of strings without any additional text.\n\n${documentText}`
          }
        ],
        max_tokens: 1000,
        temperature: 0 // Set temperature to 0 for deterministic output
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    let questionsText = response.data.choices[0]?.message?.content?.trim();

    // Ensure the response is a valid JSON array
    try {
      let questions = JSON.parse(questionsText);
      // Remove any duplicate questions
      questions = [...new Set(questions.map(q => q.trim()))];
      return questions;
    } catch (parseError) {
      console.error('Error parsing questions JSON:', parseError.message);
      return [];
    }
  } catch (error) {
    console.error('Error detecting questions with OpenAI API:', error.response?.data || error.message);
    return [];
  }
}

// Updated Function: Parse Questions by Detecting via OpenAI
async function parseQuestions(document) {
  const content = document.body.content || [];
  let fullText = '';
  const elementIndices = []; // To map character positions to structural indices

  // Concatenate all text from the document and track indices
  content.forEach((element) => {
    if (element.paragraph) {
      element.paragraph.elements.forEach((el) => {
        if (el.textRun && el.textRun.content) {
          const start = fullText.length + 1; // Google Docs API starts at 1
          const text = el.textRun.content;
          fullText += text;
          const end = fullText.length + 1;
          elementIndices.push({ start, end, element: el });
        }
      });
      fullText += '\n'; // Preserve paragraph breaks
    }
  });

  // Detect questions using OpenAI
  const detectedQuestions = await detectQuestions(fullText);

  console.log('Detected Questions from OpenAI:', detectedQuestions);

  // Locate questions in the document
  const questions = [];

  detectedQuestions.forEach((question) => {
    let searchStartIndex = 0;
    while (true) {
      const index = fullText.indexOf(question, searchStartIndex);
      if (index === -1) break;

      // Find the corresponding structural index
      const charIndex = index + 1; // Google Docs API starts at 1
      let location = null;
      for (const elem of elementIndices) {
        if (charIndex >= elem.start && charIndex < elem.end) {
          location = charIndex + question.length;
          break;
        }
      }

      if (location !== null) {
        questions.push({
          text: question,
          location: location,
          answered: false
        });
      }

      searchStartIndex = index + question.length;
    }
  });

  return questions;
}

// Existing Function: Generate Answer remains the same
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

// Updated Function: Simulate Typing and Insert in Chunks
async function simulateTypingAndInsert(docId, insertIndex, answerText) {
  const words = answerText.split(' ');
  const chunkSize = 5; // Number of words per batch
  const wordsPerMinute = 100 + Math.random() * 20; // Faster typing
  const delay = (60 / wordsPerMinute) * 1000; // Delay between words in ms

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize).join(' ') + ' ';
    const requests = [
      {
        insertText: {
          location: { index: insertIndex },
          text: chunk
        }
      }
    ];
    try {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
      insertIndex += chunk.length;
    } catch (error) {
      console.error('Error inserting text:', error.message);
      break;
    }
    await new Promise((res) => setTimeout(res, delay * chunkSize)); // Pause based on number of words
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
      <p>Your document-integrated AI is ready to help!</p>
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
      <p>Example: www.homeaitob.org/start/<strong>{document-ID}</strong></p>
      <p>Find your document ID by opening your document and copying the ID from the URL.</p>
      <p>https://docs.google.com/document/d/<strong>{document-ID}</strong>/edit</p>
      <p>Note: Will not work unless you are an approved user.</p>
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
    const questions = await parseQuestions(document); // Await the updated parseQuestions

    console.log(`Detected ${questions.length} question(s) in the document.`);
    console.log('Questions to process:', questions.map(q => q.text));

    if (questions.length === 0) {
      console.log('No questions detected in the document.');
      return;
    }

    // Sort questions in descending order of location to prevent index shifting
    questions.sort((a, b) => b.location - a.location);

    for (const question of questions) {
      if (!question.answered) {
        console.log(`Processing question: "${question.text}"`);
        const answer = await generateAnswer(question.text);
        if (!answer) {
          console.log('No answer generated.');
          continue;
        }

        const insertIndex = question.location;
        const fullAnswer = `\nAnswer: ${answer}\n`;
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
