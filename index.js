// Bring in environment secrets through dotenv
require("dotenv/config")
const fs = require("fs");
const request = require("request")
// Run the express app
const express = require("express")
const app = express()
const http = require('http');
const url = require('url');
const open = require('open');
const destroyer = require('server-destroy');


//google api
const { google } = require("googleapis");
const sheets = google.sheets('v4');
const oauth2Client = new google.auth.OAuth2(
    process.env.googleClientID,
    process.env.googleClientSecret,
    process.env.googleRedirectURL
);
const scopes = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents"
];

let users = [];

app.use(express.json());

app.get("/", (req, res) => { //authorizing them

    // Step 1: 
    // Check if the code parameter is in the url 
    // if an authorization code is available, the user has most likely been redirected from Zoom OAuth
    // if not, the user needs to be redirected to Zoom OAuth to authorize
    if (req.query.code) {
        // Step 3: 
        // Request an access token using the auth code

        let url = "https://zoom.us/oauth/token?grant_type=authorization_code&code=" + req.query.code + "&redirect_uri=" + process.env.zoomRedirectURL;

        function isAuthenticated(zoom_id) {
            return new Promise((resolve, reject) => {
                const authUrl = oauth2Client.generateAuthUrl({
                    // "online" (default) or "offline" (gets refresh_token)
                    access_type: "offline",
                    // response_type: "code",
                    scope: scopes,
                });
                // res.redirect(authUrl)
                const server = http
                    .createServer(async (request, response) => {
                        try {
                            if (request.url.indexOf('/oauth2callback') > -1) {
                                // acquire the code from the querystring, and close the web server.
                                const qs = new URL(request.url, 'http://localhost:3000')
                                    .searchParams;
                                let code = qs.get('code');
                                console.log(`Code is ${code}`);
                                response.end('Authentication successful! Please return to the console.');
                                server.destroy();

                                // Now that we have the code, use that to acquire tokens.
                                const r = await oauth2Client.getToken(code);
                                // Make sure to set the credentials on the OAuth2 client.
                                if (r.tokens.refresh_token) {
                                    users[users.map(user => user.id).indexOf(zoom_id)].googleCreds = r.tokens;
                                    console.log(r.tokens);
                                    console.log(`Successful: ${JSON.stringify(req.query, null, 2)}`);
                                    console.info('Tokens acquired.');
                                    resolve(true);
                                }
                                resolve(false);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    })
                    .listen(3000, () => {
                        // open the browser to the authorize url to start the workflow
                        open(authUrl, { wait: false }).then(cp => cp.unref());
                    });
                destroyer(server);
            });
        }

        request.post(url, (error, response, body) => { //sent the query code to Zoom to get access tokens
            body = JSON.parse(body);

            let tokenData = body;

            if (body.access_token) {

                // Step 4:
                // We can now use the access token to authenticate API calls

                // Send a request to get your user information using the /me context
                // The `/me` context restricts an API call to the user the token belongs to
                // This helps make calls to user-specific endpoints instead of storing the userID

                request.get("https://api.zoom.us/v2/users/me", async (error, response, body) => {
                    body = JSON.parse(body);
                    if (error) {
                        console.log("API Response Error: ", error)
                    } else {
                        console.log(body);
                        let user = {
                            id: body.id,
                            meetings: [],
                            zoomCreds: {
                                refresh_token: tokenData.refresh_token,
                                access_token: tokenData.access_token
                            }
                        };
                        users.push(user);
                        try {
                            if (await isAuthenticated(user.id)) {
                                console.log("Auth completed. You have been verified with Google.");
                                res.end();
                            }
                        }
                        catch (error) {
                            console.log(error);
                            delete users[users.indexOf(user)];
                            console.log("Auth failed. Google did not authenticate properly or in time.");
                            res.end();
                        }
                    }
                }).auth(null, null, true, body.access_token);

            } else {
                // Handle errors, something"s gone wrong!
                res.end("No access token provided.");
            }

        }).auth(process.env.zoomClientID, process.env.zoomClientSecret);
        return;

    }

    // Step 2: 
    // If no authorization code is available, redirect to Zoom OAuth to authorize
    res.redirect("https://zoom.us/oauth/authorize?response_type=code&client_id=" + process.env.zoomclientID + "&redirect_uri=" + process.env.zoomRedirectURL);
});

// Sets up webhook for Zoom Deauthorization
app.post("/zoomdeauth", (req, res) => {
    console.log(req.body);
    res.status(200).end();
})

// Set up a webhook listener for Meeting Info
app.post("/", (req, res) => {
    let webhook;
    try {
        webhook = req.body;
    } catch (err) {
        console.log(`Webhook Error: ${err.message}`);
        res.send("Failed.")
    }
    res.status(200).end();
    // Check to see if you received the event or not.
    if (req.headers.authorization === process.env.zoomVerificationToken) {
        let meeting = webhook.payload.object;
        let person;
        let i = users.map(u => u.id).indexOf(meeting.host_id);
        let meetIndex = users[i].meetings.map(m => m.uuid).indexOf(meeting.uuid);
        switch (webhook.event) {
            case "meeting.started":
                console.log(`${meeting.topic} started at time ${meeting.start_time}`);
                meeting.participants = []
                users[i].meetings.push(meeting);
                break;

            case "meeting.ended":
                let end = meeting.end_time;
                let start = meeting.start_time;
                console.log(`${meeting.topic} ended at time ${end}`);
                users[i].meetings[meetIndex].end_time = meeting.end_time;

                // This is the part where we have to create a spreadsheet and place it in user's drive.
                fs.writeFile("current-users.json", JSON.stringify(users, null, 2), (err) => {
                    if (err) throw err;
                    console.log("Updated!");
                });

                let date = start.slice(0, start.indexOf("T")).split("-");
                
                createSheet(oauth2Client, `${meeting.topic} ${date[1]}/${date[2]}/${date[0]}`, i);
                break;

            case "meeting.participant_joined":
                person = meeting.participant;
                console.log(`${person.user_name} joined ${meeting.topic} at time ${person.join_time}`);
                users[i].meetings[meetIndex].participants.push(person);
                break;

            case "meeting.participant_left":
                person = meeting.participant;
                console.log(`${person.user_name} left ${meeting.topic} at time ${person.leave_time}`);
                users[i].meetings[meetIndex].participants[users[i].meetings[meetIndex].participants.
                    map(p => p.user_id).indexOf(meeting.participant.user_id)].leave_time = meeting.participant.leave_time;
                break;
        }
    }
    // function to create spreadsheet
    async function createSheet(auth, msg, i) {
        oauth2Client.setCredentials({
            refresh_token: users[i].googleCreds.refresh_token
          });
        google.options({ auth });
        // create the spreadsheet
        const createResponse = await sheets.spreadsheets.create({
            resource: {
                properties: {
                    title: `Attendance ${msg}` // title of spreadsheet
                },
                sheets: [ // the sheets (individual tabs), we'll prob only have one
                    {
                        properties: {
                            title: 'Attendance',
                            gridProperties: {
                                rowCount: 50,
                                columnCount: 5
                            }
                        }
                    }
                ]
            }
        });

        // still in progress
        const res = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: createResponse.data.spreadsheetId,
            resource: {
                requests: [
                    {
                        insertDimension: {
                            range: {
                                sheetId: createResponse.data.sheets[0].properties.sheetId,
                                dimension: 'COLUMNS',
                                startIndex: 2,
                                endIndex: 4,
                            },
                            inheritFromBefore: false,
                        },
                    },
                ],
            },
        });
        console.info(res);
        return res.data;
    }

});


app.listen(4000, () => console.log(`Zoom app listening at PORT: 4000`))