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

// Updated Function: Parse Questions by Relying on OpenAI's Detection
async function parseQuestions(document) {
  const content = document.body.content || [];
  
  // Concatenate all text from the document
  let fullText = '';
  content.forEach((element) => {
    if (element.paragraph) {
      element.paragraph.elements.forEach((el) => {
        if (el.textRun && el.textRun.content) {
          fullText += el.textRun.content;
        }
      });
      fullText += '\n'; // Preserve paragraph breaks
    }
  });

  // Detect questions using OpenAI
  const detectedQuestions = await detectQuestions(fullText);

  console.log('Detected Questions from OpenAI:', detectedQuestions);

  // Locate questions in the document and map to endIndex
  const questions = [];
  detectedQuestions.forEach((question) => {
    const escapedQuestion = question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape special characters
    const regex = new RegExp(escapedQuestion, 'g'); // Create a global regex
    let match;
    while ((match = regex.exec(fullText)) !== null) {
      const characterIndex = match.index + match[0].length;
      const insertIndex = mapCharacterIndexToEndIndex(content, characterIndex);
      if (insertIndex !== null) {
        questions.push({
          text: question,
          endIndex: insertIndex,
          answered: false
        });
      }
    }
  });

  console.log('Final Questions to process:', questions.map(q => q.text));

  return questions;
}

// Helper Function: Map Character Index to Google Docs endIndex
function mapCharacterIndexToEndIndex(content, characterIndex) {
  let currentChar = 0;
  for (const element of content) {
    if (element.paragraph) {
      for (const el of element.paragraph.elements) {
        if (el.textRun && el.textRun.content) {
          const text = el.textRun.content;
          const nextChar = currentChar + text.length;
          if (characterIndex <= nextChar) {
            return element.endIndex; // Insert after the current paragraph
          }
          currentChar = nextChar;
        }
      }
      // Account for paragraph break
      currentChar += 1; // Assuming '\n' is one character
    }
  }
  return null; // Not found
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
  let totalInserted = 0; // Track total characters inserted

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
      totalInserted += chunk.length;
      insertIndex += chunk.length;
    } catch (error) {
      console.error(`Error inserting text at index ${insertIndex}:`, error.message);
      break;
    }
    await new Promise((res) => setTimeout(res, delay * chunkSize)); // Pause based on number of words
  }

  return totalInserted; // Return the number of characters inserted
}

// Home Page Route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome - HomeAItoB</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 2em; 
          text-align: center; 
          background-color: #f4f4f4;
        }
        .container { 
          background-color: #fff; 
          padding: 2em; 
          border-radius: 8px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 600px; 
          margin: auto;
        }
        h1 { color: #333; }
        a {
          display: inline-block;
          margin: 1em 0;
          padding: 0.5em 1em;
          background-color: #007bff;
          color: #fff;
          text-decoration: none;
          border-radius: 4px;
        }
        a:hover {
          background-color: #0056b3;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Welcome to HomeAItoB</h1>
        <p>Your document-integrated AI is ready to help!</p>
        <a href="/start">Get Started</a> | <a href="/about">About</a> | <a href="/purchase">Purchase</a>
      </div>
    </body>
    </html>
  `);
});

// About Page Route
app.get('/about', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>About - HomeAItoB</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 2em; 
          background-color: #f4f4f4;
          color: #333;
        }
        .container { 
          background-color: #fff; 
          padding: 2em; 
          border-radius: 8px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 800px; 
          margin: auto;
        }
        h1 { color: #333; }
        p { line-height: 1.6; }
        a {
          color: #007bff;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>About HomeAItoB</h1>
        <p>
          Welcome to <strong>HomeAItoB</strong>, your integrated AI assistant designed to enhance your Google Docs experience. Whether you're a student, teacher, or professional, HomeAItoB helps you by automatically detecting questions in your documents and providing insightful answers.
        </p>
        <h2>About the Creator</h2>
        <p>
          HomeAItoB was developed by an anonymous individual from <strong>Mira Costa High School</strong>. Driven by a passion for technology and education, the creator aimed to build a tool that simplifies the process of understanding and enriching written content. By leveraging the power of OpenAI's language models and Google Docs APIs, HomeAItoB stands as a testament to innovative problem-solving and dedication to improving learning and productivity.
        </p>
        <h2>Features</h2>
        <ul>
          <li>Automatically detects and processes questions within your Google Docs.</li>
          <li>Provides well-researched and accurate answers to your queries.</li>
          <li>Ensures seamless integration without disrupting your document's flow.</li>
        </ul>
        <p>
          Thank you for using HomeAItoB! We hope this tool enhances your document creation and study processes.
        </p>
        <p>
          <a href="/">Go Back Home</a> | <a href="/purchase">Purchase</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

// Purchase Page Route (Placeholder)
app.get('/purchase', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Purchase - HomeAItoB</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 2em; 
          background-color: #f4f4f4;
          color: #333;
        }
        .container { 
          background-color: #fff; 
          padding: 2em; 
          border-radius: 8px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 600px; 
          margin: auto;
          text-align: center;
        }
        h1 { color: #333; }
        p { line-height: 1.6; }
        a {
          color: #007bff;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
        button {
          padding: 0.5em 1em;
          background-color: #007bff;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 1em;
        }
        button:hover {
          background-color: #0056b3;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Purchase Coming Soon!</h1>
        <p>
          We're working hard to bring you premium features and support HomeAItoB's development. Stay tuned for updates on purchase options and exclusive benefits.
        </p>
        <button disabled>Purchase Options Coming Soon</button>
        <p>
          <a href="/">Go Back Home</a> | <a href="/about">About</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

// Start Page Route - Serves the Form
app.get('/start', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Start - HomeAItoB</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 2em; 
          text-align: center; 
          background-color: #f4f4f4;
        }
        .container { 
          background-color: #fff; 
          padding: 2em; 
          border-radius: 8px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 500px; 
          margin: auto;
        }
        h1 { color: #333; }
        input[type="text"] {
          width: 80%;
          padding: 0.5em;
          margin: 1em 0;
          border: 1px solid #ccc;
          border-radius: 4px;
        }
        button {
          padding: 0.5em 1em;
          background-color: #28a745;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover {
          background-color: #218838;
        }
        .directions {
          text-align: left;
          margin-bottom: 1em;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Process Your Document</h1>
        <div class="directions">
          <h3>How to Find Your Document ID:</h3>
          <ol>
            <li>Open your Google Docs document.</li>
            <li>Look at the URL in your browser's address bar.</li>
            <li>Copy the part between <strong>/d/</strong> and <strong>/edit</strong>.</li>
            <li>It should look something like this: <code>1OY_nkK0sIb60qtFiY6CqMgrPviRKME9TBDyY8yR_ojc</code></li>
          </ol>
        </div>
        <form id="documentForm">
          <input type="text" id="documentId" name="documentId" placeholder="Enter your Document ID" required />
          <br/>
          <button type="submit">Submit</button>
        </form>
      </div>
      
      <script>
        document.getElementById('documentForm').addEventListener('submit', function(event) {
          event.preventDefault(); // Prevent the default form submission
          const docId = document.getElementById('documentId').value.trim();
          if(docId) {
            // Redirect to /start/:documentId
            window.location.href = '/start/' + docId;
          }
        });
      </script>
    </body>
    </html>
  `);
});



// `/start/:documentId` Route
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
      <title>Processing Document - HomeAItoB</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 2em; 
          text-align: center; 
          background-color: #f4f4f4;
        }
        .container { 
          background-color: #fff; 
          padding: 2em; 
          border-radius: 8px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 600px; 
          margin: auto;
        }
        h1 { color: #333; }
        p { line-height: 1.6; }
        a {
          color: #007bff;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Processing Document</h1>
        <p>Document ID: ${documentId}</p>
        <p>Processing your document. This may take a moment...</p>
        <a href="/">Go Back Home</a>
      </div>
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
    const questions = await parseQuestions(document); // Updated parseQuestions

    console.log(`Detected ${questions.length} question(s) in the document.`);
    console.log('Questions to process:', questions.map(q => q.text));

    if (questions.length === 0) {
      console.log('No questions detected in the document.');
      return;
    }

    // Sort questions in ascending order of endIndex to insert answers chronologically
    questions.sort((a, b) => a.endIndex - b.endIndex);

    let cumulativeOffset = 0; // Initialize cumulative offset

    for (const question of questions) {
      if (!question.answered) {
        console.log(`Processing question: "${question.text}"`);
        const answer = await generateAnswer(question.text);
        if (!answer) {
          console.log('No answer generated.');
          continue;
        }

        let insertIndex = question.endIndex - 1 + cumulativeOffset; // Adjusted insertion index

        // Safeguard: Ensure insertIndex is within bounds
        if (insertIndex < 0) {
          console.warn(`Invalid insertIndex ${insertIndex} for question "${question.text}". Skipping insertion.`);
          continue;
        }

        const fullAnswer = `\nAnswer: ${answer}\n`;
        console.log(`Inserting answer at index ${insertIndex}`);
        const insertedChars = await simulateTypingAndInsert(documentId, insertIndex, fullAnswer);

        // Update cumulativeOffset based on the number of characters inserted
        cumulativeOffset += insertedChars;

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
