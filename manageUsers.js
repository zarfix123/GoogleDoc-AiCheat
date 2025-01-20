/**
 * manageUsers.js
 * Allows creation and deletion of users in Google Workspace
 * using domain-wide delegated service account.
 */
const { google } = require('googleapis');
const fs = require('fs');

// Load local JSON key
const credentials = JSON.parse(
  fs.readFileSync('service_account_key.json', 'utf8')
);

// Create JWT client for Admin SDK (domain-wide delegation)
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
  // Must be a super admin in your domain
  subject: 'zarfix@homeaitob.org', // <--- REPLACE with your super admin
});

// Admin SDK
const admin = google.admin({ version: 'directory_v1', auth });

// CREATE a user
async function createUser(email, password, displayName) {
  try {
    const [givenName, ...rest] = displayName.split(' ');
    const familyName = rest.join(' ') || 'Bot'; // fallback
    const res = await admin.users.insert({
      requestBody: {
        primaryEmail: email,
        name: {
          givenName,
          familyName,
        },
        password,
        changePasswordAtNextLogin: true,
      },
    });
    console.log('User created:', res.data);
  } catch (error) {
    console.error('Error creating user:', error);
  }
}

// DELETE a user
async function deleteUser(email) {
  try {
    // userKey can be user's primary email or user id
    const res = await admin.users.delete({ userKey: email });
    console.log(`User ${email} deleted successfully.`);
  } catch (error) {
    console.error('Error deleting user:', error);
  }
}

// CLI logic
(async () => {
  const action = process.argv[2]; // e.g. 'create' or 'delete'
  if (!action) {
    console.log('Usage: node manageUsers.js <action> <email> [<password> <displayName>]');
    return;
  }

  if (action === 'create') {
    const email = process.argv[3];
    const password = process.argv[4];
    const displayName = process.argv[5];
    if (!email || !password || !displayName) {
      console.log('Usage: node manageUsers.js create <email> <password> "<displayName>"');
      return;
    }
    await createUser(email, password, displayName);
  } else if (action === 'delete') {
    const email = process.argv[3];
    if (!email) {
      console.log('Usage: node manageUsers.js delete <email>');
      return;
    }
    await deleteUser(email);
  } else {
    console.log('Invalid action. Use "create" or "delete".');
  }
})();
