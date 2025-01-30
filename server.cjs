// server.cjs

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(express.json());

// Approved Email List
const approvedEmails = [
  'zarfix.42@gmail.com',
  'dennis24.f@gmail.com',
  '26freymand@mbusdapps.org',
  ...(process.env.APPROVED_EMAILS ? process.env.APPROVED_EMAILS.split(',') : []) // Add emails from .env if any
];

// Initialize Google APIs
const credentials = {
  client_email: process.env.CLIENT_EMAIL,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // Handle newline characters
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

/**
 * Check if the document owner is approved.
 * @param {string} docId - The Google Docs Document ID.
 * @returns {Promise<boolean>} - Returns true if approved, else false.
 */
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

/**
 * Fetch the Google Docs document content.
 * @param {string} docId - The Google Docs Document ID.
 * @returns {Promise<object>} - Returns the document data.
 */
async function fetchDocument(docId) {
  try {
    const res = await docs.documents.get({ documentId: docId });
    return res.data;
  } catch (error) {
    console.error(`Failed to fetch document ${docId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Calculate the Levenshtein distance between two strings.
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} - The Levenshtein distance.
 */
function getLevenshteinDistance(a, b) {
  const matrix = [];

  // Ensure neither string is empty
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Initialize the first row and column of the matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Populate the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,    // Deletion
          matrix[i][j - 1] + 1,    // Insertion
          matrix[i - 1][j - 1] + 1 // Substitution
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Detect questions in the document text using OpenAI.
 * @param {string} documentText - The full text of the document.
 * @returns {Promise<string[]>} - Returns an array of detected questions.
 */
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

/**
 * Normalize text by converting to lowercase and removing punctuation.
 * @param {string} text - The text to normalize.
 * @returns {string} - The normalized text.
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]+/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')       // Replace multiple spaces with single space
    .trim();
}
/**
 * Check if a question at a given endIndex has already been answered.
 * @param {object[]} content - The content array from the Google Docs document.
 * @param {number} questionEndIndex - The endIndex of the question in the document.
 * @returns {boolean} - Returns true if answered, else false.
 */
function isQuestionAnswered(content, questionEndIndex) {
  // Find the element with the given endIndex
  const index = content.findIndex(element => element.endIndex === questionEndIndex);
  if (index === -1) {
    return false; // Can't find the question element, assume not answered
  }
  
  // Check the next element for an answer
  const nextElement = content[index + 1];
  if (nextElement && nextElement.paragraph) {
    const paraText = nextElement.paragraph.elements
      .filter(el => el.textRun && el.textRun.content)
      .map(el => el.textRun.content)
      .join('')
      .trim();
    return paraText.startsWith('Answer:');
  }
  
  return false;
}

/**
 * Parse questions from the document using OpenAI's detection.
 * @param {object} document - The Google Docs document object.
 * @returns {Promise<object[]>} - Returns an array of question objects with text and endIndex.
 */
async function parseQuestions(document) {
  const content = document.body.content || [];

  // Extract all lines from the document
  const lines = [];
  content.forEach(element => {
    if (element.paragraph) {
      const paraText = element.paragraph.elements
        .filter(el => el.textRun && el.textRun.content)
        .map(el => el.textRun.content)
        .join('')
        .trim();
      // Split paragraph into lines based on manual line breaks or multiple spaces
      const splitLines = paraText.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0);
      lines.push(...splitLines);
    }
  });

  console.log('Document Lines:', lines);

  // Detect questions using OpenAI
  const detectedQuestions = await detectQuestions(lines.join('\n'));

  console.log('Detected Questions from OpenAI:', detectedQuestions);

  // Normalize detected questions
  const normalizedDetectedQuestions = detectedQuestions.map(q => normalizeText(q));

  // Define a similarity threshold (optional, can be used as a fallback)
  const similarityThreshold = 0.8;

  // Locate questions in the document using substring matching
  const questions = [];
  for (let index = 0; index < detectedQuestions.length; index++) {
    const question = detectedQuestions[index];
    const normalizedQuestion = normalizedDetectedQuestions[index];
    let isMatched = false;
    let matchedEndIndex = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const normalizedLine = normalizeText(line);

      // Check if the normalized question is a substring of the normalized line
      if (normalizedLine.includes(normalizedQuestion)) {
        // Retrieve the corresponding paragraph to get the endIndex
        const matchedElement = content.find(element => {
          if (element.paragraph) {
            const paraText = element.paragraph.elements
              .filter(el => el.textRun && el.textRun.content)
              .map(el => el.textRun.content)
              .join('')
              .trim();
            return normalizeText(paraText).includes(normalizedQuestion);
          }
          return false;
        });

        if (matchedElement && matchedElement.endIndex) {
          // Check if this question has already been answered
          const alreadyAnswered = isQuestionAnswered(content, matchedElement.endIndex);
          if (alreadyAnswered) {
            console.log(`Question "${question}" is already answered. Skipping.`);
            isMatched = true;
            break; // Skip to the next question
          }

          questions.push({
            text: question, // Use the original question text
            endIndex: matchedElement.endIndex,
          });
          console.log(`Matched Question: "${question}" at endIndex ${matchedElement.endIndex}`);
          isMatched = true;
          break; // Move to the next detected question
        }
      }
    }

    // If not matched via substring, optionally use similarity score as a fallback
    if (!isMatched) {
      // Iterate through lines to find the highest similarity
      let highestSimilarity = 0;
      let bestMatchLine = null;

      lines.forEach((line, lineIndex) => {
        const normalizedLine = normalizeText(line);
        const distance = getLevenshteinDistance(normalizedQuestion, normalizedLine);
        const maxLength = Math.max(normalizedQuestion.length, normalizedLine.length);
        const similarity = 1 - distance / maxLength;

        console.log(`Comparing "${normalizedQuestion}" with "${normalizedLine}": Similarity = ${similarity.toFixed(2)}`);

        if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
          bestMatchLine = line;
        }
      });

      // Check if the highest similarity exceeds the threshold
      if (highestSimilarity >= similarityThreshold && bestMatchLine) {
        // Retrieve the corresponding paragraph to get the endIndex
        const matchedElement = content.find(element => {
          if (element.paragraph) {
            const paraText = element.paragraph.elements
              .filter(el => el.textRun && el.textRun.content)
              .map(el => el.textRun.content)
              .join('')
              .trim();
            return normalizeText(paraText) === normalizeText(bestMatchLine);
          }
          return false;
        });

        if (matchedElement && matchedElement.endIndex) {
          // Check if this question has already been answered
          const alreadyAnswered = isQuestionAnswered(content, matchedElement.endIndex);
          if (alreadyAnswered) {
            console.log(`Question "${question}" is already answered via similarity. Skipping.`);
            continue; // Skip to the next question
          }

          questions.push({
            text: question, // Use the original question text
            endIndex: matchedElement.endIndex,
          });
          console.log(`Matched Question via Similarity: "${question}" with similarity ${highestSimilarity.toFixed(2)} at endIndex ${matchedElement.endIndex}`);
          isMatched = true;
        }
      }

      if (!isMatched) {
        console.warn(`Question not found in document: "${question}" (Highest Similarity: ${highestSimilarity.toFixed(2)})`);
      }
    }
  }

  console.log('Final Questions to process:', questions.map(q => q.text));

  return questions;
}

/**
 * Map a character index to Google Docs' endIndex.
 * @param {object[]} content - The content array from the Google Docs document.
 * @param {number} characterIndex - The character index in the fullText.
 * @returns {number|null} - Returns the endIndex or null if not found.
 */
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

/**
 * Generate an answer for a given question using OpenAI.
 * @param {string} questionText - The question to answer.
 * @returns {Promise<string|null>} - Returns the answer text or null if failed.
 */
// Updated `generateAnswer` function with extra context
/**
 * Generate an answer for a given question using OpenAI.
 * @param {string} questionText - The question to answer.
 * @param {string} [extraContext] - Additional context provided by the user (optional).
 * @returns {Promise<string|null>} - Returns the answer text or null if failed.
 */
async function generateAnswer(questionText, extraContext) {
  try {
    // Base prompt without extra context
    let prompt = `You are a knowledgeable assistant. Answer the following question:\n"${questionText}"`;

    // If extraContext is provided and not empty, include it in the prompt
    if (extraContext && extraContext.trim() !== '') {
      prompt = `You are a knowledgeable assistant. Here is some additional context:\n"${extraContext}"\n\nAnswer the following question based on the above context:\n"${questionText}"`;
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a knowledgeable assistant. Answer all questions in a correct, direct, yet concise manner.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 150,
        temperature: 0.5, // Adjust as needed for creativity vs. accuracy
        n: 1,
        stop: null
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    // Extract and return the AI's response
    return response.data.choices[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error('Error calling OpenAI API:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Simulate typing and insert text into the Google Docs document in chunks.
 * @param {string} docId - The Google Docs Document ID.
 * @param {number} insertIndex - The index where text should be inserted.
 * @param {string} answerText - The answer text to insert.
 * @returns {Promise<number>} - Returns the number of characters inserted.
 */


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

// Routes

/**
 * Home Page Route
 */
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
        input[type="text"], textarea {
          width: 90%;
          padding: 0.5em;
          margin: 1em 0;
          border: 1px solid #ccc;
          border-radius: 4px;
        }
        button, .back-button {
          padding: 0.5em 1em;
          background-color: #28a745;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          margin: 0.5em;
          text-decoration: none;
          display: inline-block;
        }
        button:hover, .back-button:hover {
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
            <li>Share your google doc document to <strong>impersonate@service-448308.iam.gserviceaccount.com</strong></li>

            <li>Look at the URL in your browser's address bar.</li>
            <li>Copy the part between <strong>/d/</strong> and <strong>/edit</strong>.</li>

            <li>It should look something like this: <code>1OY_nkK0sIb60qtFiY6CqMgrPviRKME9TBDyY8yR_ojc</code></li>

            <li>(Optional) Enter any extra context (like documents) to help the AI understand the context.</li>
          </ol>
        </div>
        <form id="documentForm">
          <input type="text" id="documentId" name="documentId" placeholder="Enter your Document ID" required />
          <br/>
          <textarea id="extraContext" name="extraContext" placeholder="Enter extra context (optional)" rows="5"></textarea>
          <br/>
          <button type="submit">Submit</button>
          <a href="/" class="back-button">Back Home</a>
        </form>
      </div>
      
      <script>
        document.getElementById('documentForm').addEventListener('submit', function(event) {
          event.preventDefault(); // Prevent the default form submission
          const docId = document.getElementById('documentId').value.trim();
          const extraContext = document.getElementById('extraContext').value.trim();
          if(docId) {
            // Encode the extra context to safely include it in the URL
            const encodedContext = encodeURIComponent(extraContext);
            // Redirect to /start/:documentId with extra context as a query parameter
            window.location.href = '/start/' + docId + '?extraContext=' + encodedContext;
          }
        });
      </script>
    </body>
    </html>
  `);
});


/**
 * `/start/:documentId` Route - Serves the Processing Page with Real-Time Feedback
 */
// Updated `/start/:documentId` route to handle extra context
app.get('/start/:documentId', (req, res) => {
  const documentId = req.params.documentId;
  const extraContext = req.query.extraContext || ''; // Retrieve extra context from query parameters
  
  if (!documentId) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <!-- Existing error HTML -->
    `);
  }

  // Serve the Processing Page with Loading Indicator
  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Processing Document - HomeAItoB</title>
      <style>
        /* Existing CSS styles */
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
          position: relative;
        }
        h1 { color: #333; }
        p { line-height: 1.6; }
        .spinner {
          margin: 2em auto;
          width: 50px;
          height: 50px;
          border: 5px solid #ccc;
          border-top: 5px solid #007bff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .message {
          margin-top: 1em;
          font-size: 1.1em;
          color: #555;
        }
        .error {
          color: #721c24;
          background-color: #f8d7da;
          padding: 1em;
          border-radius: 5px;
          margin-top: 1em;
        }
        .success {
          color: #155724;
          background-color: #d4edda;
          padding: 1em;
          border-radius: 5px;
          margin-top: 1em;
        }
        a {
          color: #007bff;
          text-decoration: none;
          font-weight: bold;
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
        <div class="spinner" id="spinner"></div>
        <div class="message" id="processingMessage">Your document is being processed. Please wait...</div>
        <div id="feedback"></div>
        <p><a href="/">Go Back Home</a></p>
      </div>
      
      <script>
        // Function to display messages
        function displayMessage(type, text) {
          const feedbackDiv = document.getElementById('feedback');
          feedbackDiv.innerHTML = '';
          const message = document.createElement('div');
          message.className = type;
          message.textContent = text;
          feedbackDiv.appendChild(message);
        }

        // Function to remove spinner and processing message
        function removeProcessingElements() {
          const spinner = document.getElementById('spinner');
          const processingMessage = document.getElementById('processingMessage');
          if (spinner) spinner.style.display = 'none';
          if (processingMessage) processingMessage.style.display = 'none';
        }

        // Function to retrieve query parameters
        function getQueryParams() {
          const params = {};
          window.location.search.substring(1).split("&").forEach(function(part) {
            if (!part) return;
            const item = part.split("=");
            params[decodeURIComponent(item[0])] = decodeURIComponent(item[1]);
          });
          return params;
        }

        // Initiate processing via AJAX
        async function processDocument() {
          try {
            const params = getQueryParams();
            const extraContext = params.extraContext || '';

            const response = await fetch('/api/process/' + '${documentId}', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ extraContext }) // Send extra context in the request body
            });

            // Add logging to inspect the response
            console.log('Response Status:', response.status);
            console.log('Response Headers:', response.headers.get('Content-Type'));

            // Ensure the response is JSON
            const contentType = response.headers.get('Content-Type');
            if (!contentType || !contentType.includes('application/json')) {
              throw new Error('Invalid response format: ' + contentType);
            }

            const data = await response.json();
            console.log('Received Data:', data);

            removeProcessingElements();
            if (response.ok) {
              displayMessage('success', data.message);
            } else {
              displayMessage('error', data.error);
            }
          } catch (error) {
            console.error('Fetch Error:', error);
            removeProcessingElements();
            displayMessage('error', 'An unexpected error occurred. Please try again later.');
          }
        }

        // Start processing when the page loads
        window.onload = processDocument;
      </script>
    </body>
    </html>
  `);
});
// 1. Terms and Conditions Route
app.get('/terms', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Terms and Conditions - HomeAItoB</title>
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
        ul { line-height: 1.6; }
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
        <h1>Terms and Conditions</h1>
        <p>Welcome to HomeAItoB. By accessing and using our services, you agree to comply with and be bound by the following terms and conditions:</p>
        <ul>
          <li><strong>No Disclosure of the Software:</strong> Users are prohibited from disclosing, distributing, or reproducing any part of the HomeAItoB software without explicit permission from the owner.</li>
          <li><strong>No Disclosure of the Owner/Creator:</strong> Users must not attempt to identify, disclose, or reveal any information about the owner or creator of HomeAItoB.</li>
          <li><strong>No Liability for Cheating:</strong> HomeAItoB is not responsible for any misuse of its services, including but not limited to academic dishonesty or cheating.</li>
          <li><strong>No Liability for Incorrect Answers:</strong> While HomeAItoB strives to provide accurate and helpful information, it does not guarantee the correctness of the answers provided and is not liable for any errors or omissions.</li>
          <li><strong>No Minimum Grade Agreement:</strong> HomeAItoB does not warrant or guarantee any specific academic outcomes, including grades or performance.</li>
          <li><strong>No Refunds:</strong> All payments made for HomeAItoB services are non-refundable, regardless of user satisfaction or usage.</li>
          <li><strong>Termination of Access:</strong> HomeAItoB reserves the right to terminate or restrict access to its services at its sole discretion, without prior notice.</li>
          <li><strong>Modification of Terms:</strong> HomeAItoB may modify these terms and conditions at any time. Continued use of the services constitutes acceptance of the updated terms.</li>
          <li><strong>Governing Law:</strong> These terms and conditions are governed by and construed in accordance with the laws of the jurisdiction in which HomeAItoB operates.</li>
        </ul>
        <p>For any questions or concerns regarding these terms, please contact us through our <a href="/contact">Contact Page</a>.</p>
        <p><a href="/">Go Back Home</a></p>
      </div>
    </body>
    </html>
  `);
});

// 2. Contact Page Routes

// Serve the Contact Form
app.get('/contact', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Contact Us - HomeAItoB</title>
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
        }
        h1 { color: #333; }
        form {
          display: flex;
          flex-direction: column;
        }
        label {
          margin-top: 1em;
          font-weight: bold;
        }
        input[type="text"], input[type="email"], select, textarea {
          padding: 0.5em;
          margin-top: 0.5em;
          border: 1px solid #ccc;
          border-radius: 4px;
          width: 100%;
        }
        .checkbox-container {
          margin-top: 1em;
          display: flex;
          align-items: center;
        }
        .checkbox-container input {
          margin-right: 0.5em;
        }
        button {
          padding: 0.7em;
          margin-top: 1.5em;
          background-color: #28a745;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1em;
        }
        button:hover {
          background-color: #218838;
        }
        .back-link {
          margin-top: 1em;
          text-align: center;
        }
        .back-link a {
          color: #007bff;
          text-decoration: none;
        }
        .back-link a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Contact Us</h1>
        <form id="contactForm" action="/contact" method="POST">
          <label for="name">Name:</label>
          <input type="text" id="name" name="name" required />

          <label for="email">Email:</label>
          <input type="email" id="email" name="email" required />

          <label for="subject">Subject:</label>
          <select id="subject" name="subject" required>
            <option value="">--Please choose an option--</option>
            <option value="Technical">Technical</option>
            <option value="Billing">Billing</option>
            <option value="General">General</option>
            <option value="Feedback">Feedback</option>
            <option value="Other">Other</option>
          </select>

          <label for="message">Reason for Inquiry / Support Needed:</label>
          <textarea id="message" name="message" rows="5" required></textarea>

          <div class="checkbox-container">
            <input type="checkbox" id="terms" name="terms" required />
            <label for="terms">
              I agree to the <a href="/terms" target="_blank">Terms and Conditions</a>.
            </label>
          </div>

          <button type="submit">Submit</button>
        </form>
        <div class="back-link">
          <a href="/">Go Back Home</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Handle Contact Form Submission
app.post('/contact', (req, res) => {
  const { name, email, subject, message, terms } = req.body;

  // Validate Terms and Conditions Agreement
  if (!terms) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Submission Error - HomeAItoB</title>
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
          h1 { color: #dc3545; }
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
          <h1>Submission Failed</h1>
          <p>You must agree to the <a href="/terms" target="_blank">Terms and Conditions</a> to submit the form.</p>
          <p><a href="/contact">Go Back to Contact Form</a></p>
        </div>
      </body>
      </html>
    `);
  }

  // Validate Required Fields
  if (!name || !email || !subject || !message) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Submission Error - HomeAItoB</title>
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
          h1 { color: #dc3545; }
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
          <h1>Submission Failed</h1>
          <p>All fields are required. Please fill out the form completely.</p>
          <p><a href="/contact">Go Back to Contact Form</a></p>
        </div>
      </body>
      </html>
    `);
  }

  // Sanitize Inputs (Basic Sanitization)
  const sanitizedName = name.replace(/[\r\n]/g, " ").trim();
  const sanitizedEmail = email.replace(/[\r\n]/g, " ").trim();
  const sanitizedSubject = subject.replace(/[\r\n]/g, " ").trim();
  const sanitizedMessage = message.replace(/[\r\n]/g, " ").trim();

  // Define Directory Path
  const helpDir = path.join(__dirname, 'help', sanitizedSubject);
  
  // Create Directory if it doesn't exist
  if (!fs.existsSync(helpDir)) {
    fs.mkdirSync(helpDir, { recursive: true });
  }

  // Define File Path with Timestamp
  const timestamp = Date.now();
  const filePath = path.join(helpDir, `${timestamp}.txt`);

  // Define Message Content
  const content = `
Name: ${sanitizedName}
Email: ${sanitizedEmail}
Subject: ${sanitizedSubject}
Message:
${sanitizedMessage}
Timestamp: ${new Date(timestamp).toISOString()}
  `.trim();

  // Write Message to File
  fs.writeFile(filePath, content, (err) => {
    if (err) {
      console.error('Error saving contact message:', err);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Submission Error - HomeAItoB</title>
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
            h1 { color: #dc3545; }
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
            <h1>Submission Failed</h1>
            <p>There was an error processing your request. Please try again later.</p>
            <p><a href="/contact">Go Back to Contact Form</a></p>
          </div>
        </body>
        </html>
      `);
    }

    // Success Response
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Submission Successful - HomeAItoB</title>
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
          h1 { color: #28a745; }
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
          <h1>Thank You!</h1>
          <p>Your message has been successfully submitted. We will get back to you shortly.</p>
          <p><a href="/">Go Back Home</a></p>
        </div>
      </body>
      </html>
    `);
  });
});


/**
 * API Endpoint to Process the Document
 */
// Updated `/api/process/:documentId` route to handle extra context
app.post('/api/process/:documentId', async (req, res) => {
  const documentId = req.params.documentId;
  const { extraContext } = req.body; // Destructure extraContext from the request body
  
  if (!documentId) {
    return res.status(400).json({ error: 'Missing Document ID.' });
  }

  try {
    // Check if the document owner is approved
    const approved = await isDocumentOwnerApproved(documentId);
    if (!approved) {
      console.log(`Document ${documentId} is not from an approved owner.`);
      return res.status(403).json({ error: 'Your email address is not authorized to use this service.' });
    }

    console.log(`Starting processing for document: ${documentId}`);
    console.log(`Extra Context Provided: "${extraContext}"`);

    const document = await fetchDocument(documentId);
    const questions = await parseQuestions(document); // Using OpenAI's detection

    console.log(`Detected ${questions.length} question(s) in the document.`);
    console.log('Questions to process:', questions.map(q => q.text));

    if (questions.length === 0) {
      console.log('No questions detected in the document.');
      return res.status(200).json({ message: 'Your document has no detectable questions.' });
    }

    // Sort questions in ascending order of endIndex to insert answers chronologically
    questions.sort((a, b) => a.endIndex - b.endIndex);

    let cumulativeOffset = 0; // Initialize cumulative offset

    for (const question of questions) {
      console.log(`Processing question: "${question.text}"`);
      const answer = await generateAnswer(question.text, extraContext); // Pass extraContext to generateAnswer
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
    }

    console.log(`Finished processing document: ${documentId}`);

    // Send Success Response
    return res.status(200).json({ message: 'Your document has been processed successfully.' });
  } catch (error) {
    console.error('Error processing document:', error);

    // Send Error Response
    return res.status(500).json({ error: 'An error occurred while processing your document. Please try again later.' });
  }
});

/**
 * Start the Server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
