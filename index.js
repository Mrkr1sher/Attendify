// Bring in environment secrets through dotenv
require('dotenv/config')
const fs = require('fs');
const request = require('request')
const path = require('path');
const http = require('http');
const url = require('url');
const opn = require('open');
const destroyer = require('server-destroy');

// Run the express app
const express = require('express')
const app = express()

//google api
const { google } = require('googleapis');
const plus = google.plus('v1');

const VERIFICATION_TOKEN = "zs1zG1obSoiSMTRjgplIOA";
const NGROK_LINK = "http://3415d37069a7.ngrok.io"

let meetings = [];

app.use(express.json());

// To use OAuth2 authentication, we need access to a a CLIENT_ID, CLIENT_SECRET, AND REDIRECT_URI.  To get these credentials for your application, visit https://console.cloud.google.com/apis/credentials.
const keyPath = path.join(__dirname, 'oauth2.keys.json');
let keys = { redirect_uris: [''] };
if (fs.existsSync(keyPath)) {
    keys = require(keyPath).web;
}

// Create a new OAuth2 client with the configured keys.
const oauth2Client = new google.auth.OAuth2(
    keys.client_id,
    keys.client_secret,
    keys.redirect_uris[0]
);

google.options({ auth: oauth2Client });

app.get('/', (req, res) => {

    // Step 1: 
    // Check if the code parameter is in the url 
    // if an authorization code is available, the user has most likely been redirected from Zoom OAuth
    // if not, the user needs to be redirected to Zoom OAuth to authorize
    if (req.query.code) {
        // Step 3: 
        // Request an access token using the auth code

        let url = 'https://zoom.us/oauth/token?grant_type=authorization_code&code=' + req.query.code + '&redirect_uri=' + process.env.redirectURL;

        request.post(url, (error, response, body) => {
            body = JSON.parse(body);

            if (body.access_token) {

                // Step 4:
                // We can now use the access token to authenticate API calls

                // Send a request to get your user information using the /me context
                // The `/me` context restricts an API call to the user the token belongs to
                // This helps make calls to user-specific endpoints instead of storing the userID

                request.get('https://api.zoom.us/v2/users/me', (error, response, body) => {
                    if (error) {
                        console.log('API Response Error: ', error)
                    } else {
                        authenticate().catch(console.error);
                    }
                }).auth(null, null, true, body.access_token);

            } else {
                // Handle errors, something's gone wrong!
            }

        }).auth(process.env.clientID, process.env.clientSecret);
        return;

    }
    async function authenticate() {
        return new Promise((resolve, reject) => {

            // redirect to the google oauth url
            res.redirect(oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/plus.me'].join(' '),
            }));

            const server = http
                .createServer(async (req, res) => {
                    try {
                        if (req.url.indexOf('/oauth2callback') > -1) {
                            const qs = new url.URL(req.url, NGROK_LINK)
                                .searchParams;
                            res.end('Authentication successful! Please return to the console.');
                            server.destroy();
                            const { tokens } = await oauth2Client.getToken(qs.get('code'));
                            oauth2Client.credentials = tokens; // eslint-disable-line require-atomic-updates
                            resolve(oauth2Client);
                        }
                    } catch (e) {
                        reject(e);
                    }
                })
            destroyer(server);
        });
    }

    // Step 2: 
    // If no authorization code is available, redirect to Zoom OAuth to authorize
    res.redirect('https://zoom.us/oauth/authorize?response_type=code&client_id=' + process.env.clientID + '&redirect_uri=' + process.env.redirectURL);
});

// Set up a webhook listener for Webhook Event
app.post('/', (req, res) => {
    res.status(200).end();
    let webhook;
    let meeting;
    try {
        webhook = req.body;
    } catch (err) {
        console.log(`Webhook Error: ${err.message}`);
    }
    // Check to see if you received the event or not.
    if (req.headers.authorization === VERIFICATION_TOKEN) {
        switch (webhook.event) {
            case "meeting.started":
                console.log(`${webhook.payload.object.topic} started at time ${webhook.payload.object.start_time}`);
                meeting = webhook.payload.object;
                meeting.participants = [];
                meetings.push(meeting);
                break;
            case "meeting.ended":
                console.log(`${webhook.payload.object.topic} ended at time ${webhook.payload.object.end_time}`);
                for (let meeting of meetings) {
                    if (meeting.uuid === webhook.payload.object.uuid) {
                        meeting.end_time = webhook.payload.object.end_time;
                    }
                }
                // This is the part where we have to create a spreadsheet and place it in user's drive.
                fs.writeFile("current-meetings.json", JSON.stringify(meetings, null, 2), (err) => {
                    if (err) throw err;
                    console.log('Meetings Updated!');
                });
                break;
            case "meeting.participant_joined":
                console.log(`${webhook.payload.object.participant.user_name} joined ${webhook.payload.object.topic} at time ${webhook.payload.object.participant.join_time}`);
                for (let meeting of meetings) {
                    if (meeting.uuid === webhook.payload.object.uuid) {
                        meeting.participants.push(webhook.payload.object.participant);
                    }
                }
                break;
            case "meeting.participant_left":
                console.log(`${webhook.payload.object.participant.user_name} left ${webhook.payload.object.topic} at time ${webhook.payload.object.participant.leave_time}`);
                for (let meeting of meetings) {
                    if (meeting.uuid === webhook.payload.object.uuid) {
                        for (let participant of meeting.participants) {
                            if (participant.user_id === webhook.payload.object.participant.user_id) {
                                participant.leave_time = webhook.payload.object.participant.leave_time;
                            }
                        }
                    }
                }
                break;
        }
    }

});


app.listen(4000, () => console.log(`Zoom app listening at PORT: 4000`))