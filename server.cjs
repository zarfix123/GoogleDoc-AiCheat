require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const processedDocs = new Set();
const app = express();
app.use(express.json());

const approvedEmails = [
  //me
  'zarfix.42@gmail.com',
  'dennis24.f@gmail.com',
  '26freymand@mbusdapps.org'
 
  // person 2

  // person 3
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
    throw error; // Rethrow or handle as needed
  }
}

async function isDocumentOwnerApproved(docId) {
  try {
    const res = await drive.files.get({
      fileId: docId,
      fields: 'owners(emailAddress)'
    });
    const owners = res.data.owners || [];
    return owners.some(owner => approvedEmails.includes(owner.emailAddress));
  } catch (error) {
    console.error('Error checking document owner:', error);
    return false;
  }
}

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
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error calling OpenAI API:', error.response ? error.response.data : error.message);
    return null;
  }
}

async function simulateTypingAndInsert(docId, insertIndex, answerText) {
  const words = answerText.split(' ');
  const wordsPerMinute = 70 + Math.random() * 15;
  const adjustedWPM = wordsPerMinute * 2; // Double speed
  const delay = (60 / adjustedWPM) * 1000; // delay per word

  for (let i = 0; i < words.length; i++) {
    const word = words[i] + (i < words.length - 1 ? ' ' : '');
    const requests = [{
      insertText: {
        location: { index: insertIndex },
        text: word,
      }
    }];
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
    // Apply a uniform, shorter delay between words
    await new Promise(res => setTimeout(res, delay));
  }
}

// Route to manually trigger document processing
app.post('/webhook', async (req, res) => {
  const { documentId } = req.body;
  if (!documentId) return res.status(400).send('Missing documentId');

  if (!await isDocumentOwnerApproved(documentId)) {
    console.log(`Document ${documentId} is not from an approved owner.`);
    return res.status(403).send('Document owner not approved for processing.');
  }
  
  try {
    const document = await fetchDocument(documentId);
    const questions = parseQuestions(document);
    for (const question of questions) {
      if (!question.answered) {
        const answer = await generateAnswer(question.text);
        if (!answer) continue;
        const insertIndex = document.body.content[question.index].endIndex - 1;
        // Insert answer on a new line directly below the question
        const fullAnswer = `\n${answer}`;
        await simulateTypingAndInsert(documentId, insertIndex, fullAnswer);
        // Pause for 2 seconds between questions
        await new Promise(res => setTimeout(res, 2000));
      }
    }
    res.send('Processed document.');
  } catch (error) {
    console.error('Error in /webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Endpoint to receive Google Drive push notifications
app.post('/drive-webhook', async (req, res) => {
  console.log('Received a Drive notification.');
  res.status(200).send();  // Acknowledge notification

  // Placeholder for demonstration
  const documentId = 'PLACEHOLDER_DOCUMENT_ID';

  try {
    const fakeReq = { body: { documentId } };
    const fakeRes = {
      status: (code) => ({ send: (msg) => console.log(`Status ${code}: ${msg}`) }),
      send: (msg) => console.log(msg)
    };
    await app._router.handle(fakeReq, fakeRes, () => {});
  } catch (err) {
    console.error('Error processing document from Drive notification:', err);
  }
});

// New /start/:documentId route
app.get('/start/:documentId', async (req, res) => {
  const documentId = req.params.documentId;
  if (!documentId) {
    return res.status(400).send('Missing document ID.');
  }
  
  // Check if the document owner is approved
  const approved = await isDocumentOwnerApproved(documentId);
  if (!approved) {
    console.log(`Document ${documentId} is not from an approved owner.`);
    return res.status(403).send('Document owner not approved for processing.');
  }
  
  console.log(`Starting processing for document: ${documentId}`);
  
  try {
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
        await new Promise(res => setTimeout(res, 2000));  // pause between questions
      }
    }
    
    console.log(`Finished processing document: ${documentId}`);
    res.send(`Processed document: ${documentId}`);
  } catch (error) {
    console.error('Error processing document:', error);
    res.status(500).send('Error processing document.');
  }
}); 

// Periodic processing interval
setInterval(processNewSharedDocs, 5 * 60 * 1000); // 5 minutes interval

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

async function processNewSharedDocs() {
  try {
    const res = await drive.files.list({
      q: "'me' in readers and sharedWithMe=true",
      fields: 'files(id, name)'
    });
    const files = res.data.files;
    if (!files || files.length === 0) {
      console.log('No new shared files.');
      return;
    }
    for (const file of files) {
      if (!processedDocs.has(file.id)) {
        console.log(`Processing new file: ${file.name} (${file.id})`);
        processedDocs.add(file.id);
        const fakeReq = { body: { documentId: file.id } };
        const fakeRes = {
          status: (code) => ({ send: (msg) => console.log(`Status ${code}: ${msg}`) }),
          send: (msg) => console.log(msg)
        };
        await app._router.handle(fakeReq, fakeRes, () => {});
      }
    }
  } catch (err) {
    console.error('Error listing shared files:', err);
  }
}
