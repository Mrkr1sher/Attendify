// Bring in environment secrets through dotenv
require("dotenv/config")
const fs = require("fs");
const request = require("request")
// Run the express app
const express = require("express")
const app = express()
const https = require('https');
const url = require('url');
const open = require('open');
const destroyer = require('server-destroy');


//google api
const { google } = require("googleapis");
const sheets = google.sheets('v4');
const gmail = google.gmail('v1');
const oauth2Client = new google.auth.OAuth2(
    process.env.googleClientID,
    process.env.googleClientSecret,
    process.env.googleRedirectURL
);
const scopes = [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
];

let users = [];

app.use(express.json());

//incomplete email function
async function sendEmail(auth, subject, senderEmail, recipientEmail, msg, i) {
    auth.setCredentials({
        refresh_token: users[i].googleCreds.refresh_token
    });
    // Obtain user credentials to use for the request
    google.options({auth});

    // You can use UTF-8 encoding for the subject using the method below.
    // You can also just use a plain string if you don't need anything fancy.
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    msg = `<p>Hey there ${users[i].name},</p> <br> <p>${msg}</p> <br> <p>Best,</p> <p>Aditya and Krish from Attendify</p>`
    let messageParts = [
        `From: Attendify <${senderEmail}>`,
        `To: ${users[i].name} <${recipientEmail}>`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${utf8Subject}`,
        '',
         msg,
    ];
    const message = messageParts.join('\n');

    // The body needs to be base64url encoded.
    const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: encodedMessage,
        },
    });
    console.log(res.data);
    return res.data;
}

app.get("/", (req, res) => { //authorizing them

    // Step 1: 
    // Check if the code parameter is in the url 
    // if an authorization code is available, the user has most likely been redirected from Zoom OAuth
    // if not, the user needs to be redirected to Zoom OAuth to authorize
    if (req.query.code) {
        // Step 3: 
        // Request an access token using the auth code

        let url = "https://zoom.us/oauth/token?grant_type=authorization_code&code=" + req.query.code + "&redirect_uri=" + process.env.zoomRedirectURL;

        request.post(url, (error, response, body) => { //sent the query code to Zoom to get access tokens
            body = JSON.parse(body);
            let tokenData = body;
            console.log(tokenData);
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
                        if (users.map(u => u.id).indexOf(body.id) > -1) {
                            res.end("You have already verified with Zoom.")
                            return;
                        }
                        let authUrl = oauth2Client.generateAuthUrl({
                            // "online" (default) or "offline" (gets refresh_token)
                            access_type: "offline",
                            // response_type: "code",
                            scope: scopes,
                        });
                        authUrl += `&state=${JSON.stringify(user)}`;
                        res.redirect(authUrl)
                        return;
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
app.post("/zoomdeauth", async (req, res) => {
    if (req.headers.authorization === process.env.zoomVerificationToken) {
        console.log(req.body);
        let userIndex = users.map(u => u.id).indexOf(req.body.payload.user_id);
        if (userIndex > -1) {
            await sendEmail(oauth2Client,
                "Attendify Deauthorized", users[userIndex].gmail, users[userIndex].gmail,
                "You have successfully deauthorized Attendify. Please be sure to remove Attendify's access to your Google account by " +
                    "visiting https://myaccount.google.com/permissions.",
                userIndex).then(() => {
                    console.log(`Deleted user ${users[userIndex].name} from memory.`);
                    delete users[userIndex];
                    fs.writeFile("current-users.json", JSON.stringify(users, null, 2), (err) => {
                        if (err) throw err;
                        console.log("Updated current-users.json!");
                    });
            })
        }
        res.status(200).end();
    }
});

app.get("/oauth2callback", async (req, res) => {
        if (req.query.code && req.query.state) {
            let user = JSON.parse(req.query.state);

            let code = req.query.code;
            console.log(user);
            // Now that we have the code, use that to acquire tokens.
            const r = await oauth2Client.getToken(code);
            // Make sure to set the credentials on the OAuth2 client.
            if (r.tokens.refresh_token) {
                user.googleCreds = r.tokens;
                console.log(r.tokens);
                console.log(`Successful: ${JSON.stringify(req.query, null, 2)}`);
                console.info('Tokens acquired.');
                https.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${r.tokens.access_token}`, (resp) => {
                    resp.on('data', async d => {
                        d = JSON.parse(d);
                        console.log(d);
                        user.gmail = d.email;
                        user.name = d.name;
                        if (users.map(u => u.gmail).indexOf(user.gmail) > -1) {
                            res.end("You have already authorized this Google account to be used with Attendify.")
                            return;
                        }
                        users.push(user);
                        await sendEmail(
                            oauth2Client,
                            `Attendify Authorized`,
                            user.gmail,
                            user.gmail,
                            `You have successfully authorized Attendify. You will now be notified and sent 
                            a spreadsheet with meeting attendance for all future meetings.`,
                            users.indexOf(user)
                        ).then(() => {
                            res.end("Authorized with Google!");
                        })
                    });
                });
            }
        }
});

// Set up a webhook listener for Meeting Info
app.post("/", async (req, res) => {
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
        let i;
        let meetIndex;
        let participants;
        let idx;

        switch (webhook.event) {
            case "meeting.started":
                console.log(`${meeting.topic} started at time ${zone(meeting.start_time)[1]}`);

                i = users.map(u => u.id).indexOf(meeting.host_id);
                meeting.participants = [];

                // Add this meeting to the list of meetings under the user's data
                users[i].meetings.push(meeting);
                break;

            case "meeting.ended":
                let end = zone(meeting.end_time);
                let start = zone(meeting.start_time);
                console.log(`${meeting.topic} ended at time ${end[1]}`);

                i = users.map(u => u.id).indexOf(meeting.host_id);
                meetIndex = users[i].meetings.map(m => m.uuid).indexOf(meeting.uuid);
                participants = users[i].meetings[meetIndex].participants;

                // Find the meeting's end time through the user's data
                users[i].meetings[meetIndex].end_time = end[1];

                calculatePercent(participants, start, end);

                let date = start[0] == end[0] ? `${start[0]}` : `${start[0]} - ${end[0]}`;
                let sheetTitle = `${meeting.topic} ${date} ${start[1]} - ${end[1]}`;

                // This is the part where we have to create a spreadsheet and place it in user's drive.
                await createSheet(oauth2Client, sheetTitle, i, participants).then(async url => {
                    await sendEmail(
                        oauth2Client,
                        `Spreadsheet created: ${meeting.topic}`,
                        users[i].gmail,
                        users[i].gmail,
                        `Your spreadsheet has been created at ${url}. Be sure to check it out!`,
                        i
                    ).then(() => {
                        fs.writeFile("current-users.json", JSON.stringify(users, null, 2), (err) => {
                            if (err) throw err;
                            console.log("Updated!");
                        });
                        delete users[i].meetings[meetIndex];
                    })
                });
                break;

            case "meeting.participant_joined":
                person = meeting.participant;
                let join_time = zone(person.join_time);
                console.log(`${person.user_name} joined ${meeting.topic} at time ${join_time[1]}`);

                i = users.map(u => u.id).indexOf(meeting.host_id);
                meetIndex = users[i].meetings.map(m => m.uuid).indexOf(meeting.uuid);
                participants = users[i].meetings[meetIndex].participants;
                idx = participants.map(p => p.id).indexOf(person.id);

                // If the participant's User ID is already found in the list of participants (i.e. the index >= 0)
                // Then just access their data and add on their join time
                if (idx >= 0) {
                    participants[idx].join_times.push(join_time);
                }
                // Else, if they aren't already in the list, it means they are a new participant, so add them to the data
                // Also remove the attribute of "join_time" and basically replace it with a list of "join_times"
                else {
                    person.join_times = [join_time];
                    delete person.join_time;
                    participants.push(person);
                }
                break;

            case "meeting.participant_left":
                person = meeting.participant;
                let leave_time = zone(person.leave_time);
                console.log(`${person.user_name} left ${meeting.topic} at time ${leave_time[1]}`);

                i = users.map(u => u.id).indexOf(meeting.host_id);
                meetIndex = users[i].meetings.map(m => m.uuid).indexOf(meeting.uuid);
                if (meetIndex < 0)
                    break;
                participants = users[i].meetings[meetIndex].participants;
                idx = participants.map(p => p.id).indexOf(person.id);

                // If the list of leave times for that participant does not exist, create it
                if (!participants[idx].leave_times)
                    participants[idx].leave_times = [];
                // Add on the current leave time to the person's list of leave times
                participants[idx].leave_times.push(leave_time);
                break;
        }
    }

    // function to create spreadsheet
    async function createSheet(auth, msg, i, participants) {
        auth.setCredentials({
            refresh_token: users[i].googleCreds.refresh_token
        });
        google.options({ auth });
        // create the spreadsheet
        console.log("Create");
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
                                rowCount: 20,
                                columnCount: 5
                            }
                        }
                    }
                ]
            }
        });
        let relevantData = participants.map(p => {
            let join_times_sheet = "";
            let leave_times_sheet = ""; 
            for (let i = 0; i < p.join_times.length; i++) {
                join_times_sheet += p.join_times[i][1] + ", ";
                leave_times_sheet += p.leave_times[i][1] + ", ";
                
            }
            return [p.user_name, Math.round(p.percent_attended), join_times_sheet, leave_times_sheet];
        });
        relevantData.unshift(['Username', '% Attended', 'Join Times', 'Leave Times'])
        const res = await sheets.spreadsheets.values.append({
            spreadsheetId: createResponse.data.spreadsheetId,
            range: `A1:D${relevantData.length}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: relevantData
            },
        });
        console.info(res);
        console.log(`Created spreadsheet at link: ${createResponse.data.spreadsheetUrl}`);
        return createResponse.data.spreadsheetUrl;
    }

    // Function to calculate the percentage of the meeting that the participant attended
    function calculatePercent(participants, stime, etime) {
        // Iterate over every participant in the data
        for (let p of participants) {
            let attended = 0; // To keep track of total time spent in meeting
            let joins = p.join_times;
            let leaves = p.leave_times;
            // Go through every join/leave time (there should be an equal amount)
            for (let i = 0; i < joins.length; i++) {
                // If for some reason the final leave time is not recorded for a participant,
                // set their final leave time to just be the meeting's end time.
                if (leaves == null)
                    leaves = [];
                if (leaves[i] == null)
                    leaves.push(etime);
                attended += new Date(leaves[i]) - new Date(joins[i]);
            }
            // Set the value of the percent 
            p.percent_attended = attended * 100 / (new Date(etime) - new Date(stime));
        }
    }
    function zone(str) {
        return new Date(str).toLocaleString("en-US", { timeZone: "America/New_York" }).split(", ");
    }

});

let PORT = process.env.PORT;
if (PORT){
    app.listen(PORT, () => console.log(`Zoom app listening at PORT: ${PORT}`))
}
else {
    app.listen(4000, () => console.log(`Zoom app listening at PORT: 4000`))
}