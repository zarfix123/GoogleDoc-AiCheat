require('dotenv').config();
const { google } = require('googleapis');

const credentials = {
  client_email: process.env.CLIENT_EMAIL,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  token_uri: process.env.TOKEN_URI,
};

const SCOPES = ['https://www.googleapis.com/auth/drive'];

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: SCOPES,
});

async function setupWatch() {
  const drive = google.drive({ version: 'v3', auth });
  try {
    const res = await drive.files.watch({
      fileId: '10-lhySEMN8PsTn8dsK_Mml-KP6kmGyt_T0GCydqrZbg',  // Change this if you want to watch a specific file/folder
      requestBody: {
        id: 'unique-channel-id-' + Date.now(),
        type: 'web_hook',
        address: 'https://9bb1-47-155-12-77.ngrok-free.app/drive-webhook/', // Replace with your public URL
      },
    });
    console.log('Watch channel established:', res.data);
  } catch (error) {
    console.error('Error setting up watch:', error);
  }
}

setupWatch();
