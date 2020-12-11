// Bring in environment secrets through dotenv
require("dotenv/config")
const fs = require("fs");
const request = require("request")
// Run the express app
const express = require("express")
const app = express()

//google api
const { google } = require("googleapis");
const sheets = google.sheets('v4');
const http = require('http');
const url = require('url');
const open = require('open');
const destroyer = require('server-destroy');
const oauth2Client = new google.auth.OAuth2(
    process.env.googleClientID,
    process.env.googleClientSecret,
    process.env.googleRedirectURL
);
const scopes = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
];



let meetings = [];

app.use(express.json());

app.get("/", (req, res) => {

    if (req.query.code) {

        let url = "https://zoom.us/oauth/token?grant_type=authorization_code&code=" + req.query.code + "&redirect_uri=" + process.env.zoomRedirectURL;

        request.post(url, (error, response, body) => {
            body = JSON.parse(body);

            if (body.access_token) {

                request.get("https://api.zoom.us/v2/users/me", (error, response, body) => {
                    if (error) {
                        console.log("API Response Error: ", error)
                    } else {
                        res.redirect(oauth2Client.generateAuthUrl({
                            access_type: "offline",
                            scope: scopes,
                        }));
                    }
                }).auth(null, null, true, body.access_token);

            } else {
                // Handle errors, something's gone wrong!
            }
        }).auth(process.env.zoomClientID, process.env.zoomClientSecret);
        return;

    }
    // If no authorization code is available, redirect to Zoom OAuth to authorize
    res.redirect("https://zoom.us/oauth/authorize?response_type=code&client_id=" + process.env.clientID + "&redirect_uri=" + process.env.zoomRedirectURL);
});

app.get("/oauth2callback", async (req, res) => {
    if (req.query.code) {
        // get and handle access tokens
        const { tokens } = await oauth2Client.getToken(req.query.code).catch((e) => { console.error(e); res.send("Illegal access.") });
        oauth2Client.credentials = tokens;
        res.send(`Success.`);
    }
})

// Set up a webhook listener for Webhook Event
app.post("/", (req, res) => {
    let webhook;
    try {
        webhook = req.body;
    } catch (err) {
        console.log(`Webhook Error: ${err.message}`);
        res.send("Failed.")
    }
    res.status(200).end();
    // check if event is received
    if (req.headers.authorization === process.env.zoomVerificationToken) {
        let hook = webhook.payload.object;
        switch (webhook.event) {
            case "meeting.started":
                console.log(`${hook.topic} started at time ${hook.start_time}`);
                hook.participants = [];
                meetings.push(hook);
                break;
            case "meeting.ended":
                var e = hook.end_time
                var s = hook.start_time
                console.log(`${hook.topic} ended at time ${e}`);

                // replaced the loop you had before that searches through and checks each element
                var i = meetings.map(m => m.uuid).indexOf(hook.uuid);
                meetings[i].end_time = e;

                // create spreadsheet with title: Attendance {Meeting Name} {MM/DD/YYYY}
                var date = s.slice(0, s.indexOf("T")).split("-");
                createSheet(oauth2Client, `${hook.topic} ${date[1]}/${date[2]}/${date[0]}`);

                break;
            case "meeting.participant_joined":
                var person = hook.participant;
                console.log(`${person.user_name} joined ${hook.topic} at time ${person.join_time}`);

                // replaced the loop you had before that searches through and checks each element
                var i = meetings.map(p => p.uuid).indexOf(hook.uuid);
                meetings[i].participants.push(person);
                break;
            case "meeting.participant_left":
                var person = hook.participant;
                console.log(`${person.user_name} left ${hook.topic} at time ${person.leave_time}`);

                // replaced the loop you had before that searches through and checks each element
                var i = meetings.map(m => m.uuid).indexOf(hook.uuid);
                var i2 = meetings[i].participants.map(p => p.user_id).indexOf(person.user_id);
                meetings[i].participants[i2].leave_time = person.leave_time;
                break;
        }
    }
    // function to create spreadsheet
    async function createSheet(auth, msg) {
        console.log("145");
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