if (typeof(PhusionPassenger) !== 'undefined') {
    PhusionPassenger.configure({ autoInstall: false });
}

// Bring in environment secrets through dotenv
require("dotenv/config")
const fs = require("fs");
const request = require("request")
// Run the express app
const express = require("express")
const app = express()
const https = require('https');
const mongoose = require("mongoose");
const encrypt = require("mongoose-encryption");

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
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
];

let users = [];

app.use(express.json());

mongoose.connect("mongodb+srv://attendify-admin:Atar1_1977_release@cluster0.qvdzj.mongodb.net/usersDB", { useUnifiedTopology: true, useNewUrlParser: true, useCreateIndex: true, useFindAndModify: false });

const userSchema = new mongoose.Schema({
    userId: String,
    userInfo: Object
});

// encrypt the google credentials and zoom credentials
userSchema.plugin(encrypt, { secret: process.env.ENCRYPTION_SECRET, encryptedFields: ["userInfo.googleCreds", "userInfo.zoomCreds"] });
const stateSchema = new mongoose.Schema({
    state: String
});

const User = mongoose.model("USER", userSchema);
const State = mongoose.model("STATE", stateSchema);

// person.anything = { x: [3, 4, { y: "changed" }] };
// person.markModified('anything');
// person.save(); // Mongoose will save changes to `anything`.
/*
users: [{
        meetings: [{
            duration: Number,
            startTime: String,
            timezone: String,
            topic: String,
            id: String,
            type: Number,
            uuid: String,
            hostID: String,
            participants: Object,
            endTime: String,
        }],
        zoomCreds: {
            refreshToken: String,
            accessToken: String
        },
        googleCreds: {
            tokenType: String,
            expiryDate: Number,
            refreshToken: String,
            accessToken: String,
            scope: String
        },
        gmail: String,
        name: String
    }]*/



//Email function
async function sendEmail(auth, subject, senderEmail, recipientEmail, msg, mongoID) {
    // giving refresh token to auth scheme
    const foundUser = await User.findOne({ userId : mongoID }).exec();
    auth.setCredentials({
        refresh_token: foundUser.userInfo.googleCreds.refresh_token
    });
    // Obtain user credentials to use for the request
    google.options({ auth });

    // You can use UTF-8 encoding for the subject using the method below.
    // You can also just use a plain string if you don't need anything fancy.
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    msg = `<p>Hey there ${foundUser.userInfo.name},</p> <br> <p>${msg}</p> <br> <p>Best,</p> <p>Aditya and Krish from Attendify</p>`
    let messageParts = [
        `From: Attendify <${senderEmail}>`,
        `To: ${foundUser.userInfo.name} <${recipientEmail}>`,
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
                        const foundUser = await User.findOne({ userId : user.id }).exec();
                        if (foundUser) {
                            res.end("You have already verified with Zoom.")
                            return;
                        }
                        let authUrl = oauth2Client.generateAuthUrl({
                            // "online" (default) or "offline" (gets refresh_token)
                            access_type: "offline",
                            // response_type: "code",
                            scope: scopes,
                        });
                        const state = new State({
                            state: JSON.stringify(user)
                        })
                        await state.save();
                        authUrl += `&state=${JSON.stringify(user)}`;
                        res.redirect(authUrl);
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
        // check to see if the user exists in the DB
        const foundUser = await User.findOne({ userId : req.body.payload.user_id }).exec();
        // if they don't exist, then end the callback
        if (!foundUser) {
            return;
        }
        await sendEmail(oauth2Client,
            "Attendify Deauthorized", foundUser.userInfo.gmail, foundUser.userInfo.gmail,
            "You have successfully deauthorized Attendify. Please be sure to remove Attendify's access to your Google account by " +
            "visiting https://myaccount.google.com/permissions.",
            foundUser._id)
        console.log(`Deleted user ${foundUser.userInfo.name} from memory.`);
        // delete user from DB
        await User.deleteOne( { _id : foundUser._id});
        const allUsers = await User.find({}).exec();
        fs.writeFile("current-users.json", JSON.stringify(allUsers, null, 2), (err) => {
            if (err) throw err;
            console.log("Updated current-users.json!");
        });
        res.status(200).end();
    }
});

app.get("/oauth2callback", async (req, res) => {
    if (req.query.code && req.query.state) {
        // check if state is a valid one
        const foundState = await State.findOne({ state : req.query.state });
        if (!foundState) {
            res.send("Malformed state.")
            return;
        }
        // if state was previously there, delete it from the States collection
        await State.deleteOne({ state : req.query.state });
        // get state variable and turn it into a JS object which is a user
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
                    // console.log("254");
                    d = JSON.parse(d);
                    console.log(d);
                    // console.log("257");
                    user.gmail = d.email;
                    user.name = d.name;
                    // look for any user in DB that has the same gmail as this person
                    const foundUser = await User.findOne({ "userInfo.gmail": user.gmail });
                    // console.log("262");
                    if (foundUser) {
                        // if found, then kill this auth flow
                        res.send("You have already authorized this Google account to be used with Attendify.");
                        return;
                    }
                    // console.log("268");
                    // otherwise, made new user
                    const newUser = new User({
                        userId: user.id,
                        userInfo: user
                    })
                    // console.log("274");
                    await newUser.save();
                    // console.log("276");
                    await sendEmail(
                        oauth2Client,
                        `Attendify Authorized`,
                        user.gmail,
                        user.gmail,
                        `You have successfully authorized Attendify. You will now be notified and sent 
                            a spreadsheet with meeting attendance for all future meetings.`,
                        user.id
                    );
                    // console.log("286");
                    res.send("Authorized with Google!");
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
    res.status(200).send();
    // Check to see if you received the event or not.
    if (req.headers.authorization === process.env.zoomVerificationToken) {
        let meeting = webhook.payload.object;
        let person;
        let i;
        let meetIndex;
        let participants;
        let idx;
        let foundUser;

        switch (webhook.event) {
            case "meeting.started":
                console.log(`${meeting.topic} started at time ${zone(meeting.start_time)[1]}`);
                meeting.participants = [];
                // Add this meeting to the array of meetings in this user document
                User.findOneAndUpdate({ userId: meeting.host_id }, { $push: { "userInfo.meetings": meeting } }, null, (err) => {
                    if (err) console.log(err);
                });
                break;
            case "meeting.ended":
                let end = zone(meeting.end_time);
                let start = zone(meeting.start_time);
                console.log(`${meeting.topic} ended at time ${end[1]}`);
                foundUser = await User.findOne( { userId : meeting.host_id } ).exec();
                meetIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                participants = foundUser.userInfo.meetings[meetIndex].participants;

                // Find the meeting's end time through the user's data
                foundUser.userInfo.meetings[meetIndex].end_time = end[1];

                calculatePercent(participants, start, end);

                let date = start[0] === end[0] ? `${start[0]}` : `${start[0]} - ${end[0]}`;
                let sheetTitle = `${meeting.topic} ${date} ${start[1]} - ${end[1]}`;

                // This is the part where we have to create a spreadsheet and place it in user's drive.
                const url = await createSheet(oauth2Client, sheetTitle, foundUser.userId, participants)
                await sendEmail(
                    oauth2Client,
                    `Spreadsheet created: ${meeting.topic}`,
                    foundUser.userInfo.gmail,
                    foundUser.userInfo.gmail,
                    `Your spreadsheet has been created at ${url}. Be sure to check it out!`,
                    foundUser.userId
                )
                fs.writeFile("current-users.json", JSON.stringify(users, null, 2), (err) => {
                    if (err) throw err;
                    console.log("Updated!");
                });
                delete foundUser.userInfo.meetings[meetIndex];
                foundUser.markModified("userInfo");
                foundUser.save();
                break;

            case "meeting.participant_joined":
                person = meeting.participant;
                let join_time = zone(person.join_time);
                console.log(`${person.user_name} joined ${meeting.topic} at time ${join_time[1]}`);
                // getting the user
                foundUser = await User.findOne({ userId : meeting.host_id }).exec();
                meetIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                participants = foundUser.userInfo.meetings[meetIndex].participants;
                idx = foundUser.userInfo.meetings[meetIndex].participants.map(p => p.id).indexOf(person.id);

                // If the participant's User ID is already found in the list of participants (i.e. the index >= 0)
                // Then just access their data and add on their join time
                if (idx >= 0) {
                    foundUser.userInfo.meetings[meetIndex].participants[idx].join_times.push(join_time);
                    foundUser.markModified("userInfo");
                    await foundUser.save();
                }
                // Else, if they aren't already in the list, it means they are a new participant, so add them to the data
                // Also remove the attribute of "join_time" and replace it with a list of "join_times"
                else {
                    person.join_times = [join_time];
                    delete person.join_time;
                    foundUser.userInfo.meetings[meetIndex].participants.push(person);
                    foundUser.markModified("userInfo");
                    await foundUser.save();
                    
                    // User.findOneAndUpdate({ userId: meeting.host_id }, { $push: { "userInfo.meetings[meetIndex].participants": person } }, null, (err) => {
                    //     if (err) console.log(err);
                    // });
                }
                break;

            case "meeting.participant_left":
                person = meeting.participant;
                let leave_time = zone(person.leave_time);
                console.log(`${person.user_name} left ${meeting.topic} at time ${leave_time[1]}`);
                // find User in DB
                foundUser = await User.findOne( { userId : meeting.host_id } );
                meetIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                if (meetIndex < 0)
                    break;
                participants = foundUser.userInfo.meetings[meetIndex].participants;
                idx = foundUser.userInfo.meetings[meetIndex].participants.map(p => p.id).indexOf(person.id);

                // If the list of leave times for that participant does not exist, create it
                if (!foundUser.userInfo.meetings[meetIndex].participants[idx].leave_times)
                    foundUser.userInfo.meetings[meetIndex].participants[idx].leave_times = [];
                // Add on the current leave time to the person's list of leave times
                foundUser.userInfo.meetings[meetIndex].participants[idx].leave_times.push(leave_time);
                foundUser.markModified("userInfo");
                foundUser.save();
                break;
        }
    }
 
    // function to create spreadsheet
    async function createSheet(auth, msg, mongoID, participants) {
        const foundUser = await User.findOne( { userId : mongoID } );
        auth.setCredentials({
            refresh_token: foundUser.userInfo.googleCreds.refresh_token
        });
        google.options({ auth });
        // create the spreadsheet
        console.log("Creating spreadsheet");
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
                    p.leave_times = leaves = [];
                if (leaves[i] == null) {
                    p.leave_times.push(etime);
                    leaves.push(etime);
                }
                attended += new Date(leaves[i]) - new Date(joins[i]);
            }
            // Set the value of the percent 
            p.percent_attended = Math.min(attended * 100 / (new Date(etime) - new Date(stime)), 100);
        }
    }
    function zone(str) {
        return new Date(str).toLocaleString("en-US", { timeZone: "America/New_York" }).split(", ");
    }

});

if (typeof(PhusionPassenger) !== 'undefined') {
    app.listen('passenger', () => {
        console.log("Attendify app listening on Passenger");
    });
} else {
    app.listen(4000, () => {
        console.log("Attendify app listening on PORT 4000");
    });
}
