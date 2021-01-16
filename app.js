if (typeof (PhusionPassenger) !== 'undefined') {
    PhusionPassenger.configure({ autoInstall: false });
}

// Bring in environment secrets through dotenv
require("dotenv/config")
const fs = require("fs");
const request = require("request")
// Run the express app
const express = require("express")
const axios = require("axios");
const app = express()
const https = require('https');
const mongoose = require("mongoose");
const encrypt = require("mongoose-encryption");
const async = require("async");
const cron = require("node-cron");

//google api
const { google } = require("googleapis");
const drive = google.drive('v3')
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

app.use(express.json());

mongoose.connect(process.env.MONGODB, { useUnifiedTopology: true, useNewUrlParser: true, useCreateIndex: true, useFindAndModify: false });

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

async function restartWatchers() {
    let allUsers = await User.find();

    for (let user of allUsers) {
        if (user.userInfo.folderId && user.userInfo.resourceId) {
            console.log("Scheduling cron job for" + user.userInfo.folderId)
            await cronScheduler(oauth2Client, user.userId, user.userInfo.googleCreds.refresh_token, user.userInfo.folderId, user.userInfo.resourceId);
        }
    }
}

restartWatchers().then(() => console.log("Restarted all watchers.")).catch(err => console.log(err));

async function cronScheduler(auth, mongoId, refresh_token, folderId, resourceId) {
    let requestBody = {
        "kind": "api#channel",
        "id": folderId,
        "resourceId": folderId,
        "resourceUri": folderId,
        "type": "web_hook",
        "address": `${process.env.NGROK}/folderWatcher`,
        "expiration": Date.now() + 86400000
    }
    //* * * * *
    //0 */6 * * *
    cron.schedule('0 */6 * * *', async function() {
        auth.setCredentials({
            refresh_token: refresh_token
        });
        google.options({ auth });
        console.log('Starting a watcher for every 6 hours');
        await drive.channels.stop({
            resource : {
                id: folderId,
                resourceId: resourceId
            }
        });
        let response = await drive.files.watch({fileId : folderId, requestBody});
        let foundUser = await User.findOne({userId : mongoId}).exec();
        foundUser.userInfo.resourceId = response.data.resourceId;
        foundUser.markModified("userInfo");
        await foundUser.save();
    }, { scheduled: true });
}

//Email function
async function sendEmail(auth, subject, senderEmail, recipientEmail, msg, mongoID) {
    try {
        // giving refresh token to auth scheme
        const foundUser = await User.findOne({ userId: mongoID }).exec();
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
        console.log("Email sent.")
        return res.data;
    }
    catch (error) {
        return error;
    }
}

async function createMeeting(meeting) {
    console.log(`${meeting.topic} started at time ${zone(meeting.start_time)[1]}`);
    meeting.participants = [];
    // Add this meeting to the array of meetings in this user document
    User.findOneAndUpdate({ userId: meeting.host_id }, { $push: { "userInfo.meetings": meeting } }, null, (err) => {
        if (err) console.log(err);
    });
}

function zone(str) {
    return new Date(str).toLocaleString("en-US", { timeZone: "America/New_York" }).split(", ");
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
                        const foundUser = await User.findOne({ userId: user.id }).exec();
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
        res.status(200).send();
        console.log(req.body);
        // check to see if the user exists in the DB
        const foundUser = await User.findOne({ userId: req.body.payload.user_id }).exec();
        // if they don't exist, then end the callback
        if (!foundUser) {
            return;
        }
        await sendEmail(oauth2Client,
            "Attendify Deauthorized", foundUser.userInfo.gmail, foundUser.userInfo.gmail,
            "You have successfully deauthorized Attendify. Please be sure to remove Attendify's access to your Google account by " +
            "visiting https://myaccount.google.com/permissions.",
            foundUser.userId);
        console.log(`Deleted user ${foundUser.userInfo.name} from memory.`);
        // delete user from DB
        await User.deleteOne({ userId: foundUser.userId });
        const allUsers = await User.find({}).exec();
        fs.writeFile("current-users.json", JSON.stringify(allUsers, null, 2), (err) => {
            if (err) throw err;
            console.log("Updated current-users.json!");
        });
    }
});

app.get("/oauth2callback", async (req, res) => {
    if (req.query.code && req.query.state) {

        // check if state is a valid one
        const foundState = await State.findOne({ state: req.query.state });
        if (!foundState) {
            res.send("Malformed state.")
            return;
        }

        let requiredScopes = ["email", "profile", "openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/gmail.compose"]

        let fulfilledScopes = true;

        for (let scope of requiredScopes) {
            if (!req.query.scope.includes(scope)) {
                res.send("Required Scopes Not Authorized. Please reinstall with all scopes allowed.");
                fulfilledScopes = false;
                return;
            }
        }

        if (!fulfilledScopes) {
            return;
        }

        // if state was previously there, delete it from the States collection
        await State.deleteOne({ state: req.query.state });
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
                    d = JSON.parse(d);
                    console.log(d);
                    user.gmail = d.email;
                    user.name = d.name;
                    // look for any user in DB that has the same gmail as this person
                    const foundUser = await User.findOne({ "userInfo.gmail": user.gmail });
                    if (foundUser) {
                        // if found, then kill this auth flow
                        res.send("You have already authorized this Google account to be used with Attendify.");
                        return;
                    }
                    // otherwise, made new user
                    const newUser = new User({
                        userId: user.id,
                        userInfo: user
                    })
                    await newUser.save();
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
        let meetIndex;
        let participants;
        let idx;
        let foundUser;

        switch (webhook.event) {
            case "meeting.started":
                foundUser = await User.findOne({ userId: meeting.host_id }).exec();
                meetIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                if (meetIndex < 0) {
                    await createMeeting(meeting);
                }
                break;
            case "meeting.ended":
                let end = zone(meeting.end_time);
                let start = zone(meeting.start_time);
                console.log(`${meeting.topic} ended at time ${end[1]}`);
                foundUser = await User.findOne({ userId: meeting.host_id }).exec();
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
                // fs.writeFile("current-users.json", JSON.stringify(users, null, 2), (err) => {
                //     if (err) throw err;
                //     console.log("Updated!");
                // });
                foundUser = await User.findOne({ userId: meeting.host_id }).exec();
                foundUser.userInfo.meetings.splice(meetIndex, 1)
                foundUser.markModified("userInfo");
                await foundUser.save();
                break;

            case "meeting.participant_joined":
                person = meeting.participant;
                let join_time = zone(person.join_time);
                console.log(`${person.user_name} joined ${meeting.topic} at time ${join_time[1]}`);
                // getting the user
                foundUser = await User.findOne({ userId: meeting.host_id }).exec();
                meetIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                if (meetIndex < 0) {
                    let newMeeting = JSON.parse(JSON.stringify(meeting));
                    delete newMeeting.participant;
                    await createMeeting(newMeeting);
                    person.join_times = [join_time];
                    delete person.join_time;
                    foundUser = await User.findOne({ userId: meeting.host_id }).exec();
                    let newMeetingIndex = foundUser.userInfo.meetings.map(m => m.uuid).indexOf(meeting.uuid);
                    foundUser.userInfo.meetings[newMeetingIndex].participants.push(person);
                    foundUser.markModified("userInfo");
                    break;
                }
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
                foundUser = await User.findOne({ userId: meeting.host_id });
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
                await foundUser.save();
                break;
        }
    }

    // function to create drive folder
    async function createFolder(auth, title, mongoID) {
        let foundUser = await User.findOne({ userId: mongoID });

        auth.setCredentials({
            refresh_token: foundUser.userInfo.googleCreds.refresh_token
        });
        google.options({ auth });
        let fileMetadata = {
            'name': title,
            'mimeType': 'application/vnd.google-apps.folder'
        };
        drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        }, async (err, folder) => {
            if (err) {
                console.log(err);
            } else {
                let folderId = folder.data.id;
                foundUser.userInfo.folderId = folder.data.id;
                foundUser.markModified("userInfo");
                await foundUser.save();
                let requestBody = {
                    "kind": "api#channel",
                    "id": folderId,
                    "resourceId": folderId,
                    "resourceUri": folderId,
                    "type": "web_hook",
                    "address": `${process.env.NGROK}/folderWatcher`,
                    "expiration": Date.now() + 86400000
                }
                let response = await drive.files.watch({fileId : folderId, requestBody});
                console.log("SDJKSDKHKJHFKJSKFJHKFSJJFHKSJFJSHF Watcher enabled: " + response.data.resourceId);
                foundUser = await User.findOne({ userId: mongoID });
                foundUser.userInfo.resourceId = response.data.resourceId;
                foundUser.markModified("userInfo");
                await foundUser.save();
                await cronScheduler(auth, mongoID, foundUser.userInfo.googleCreds.refresh_token, folderId, response.data.resourceId);

                console.log('Folder Id: ' +  folder.data.id);
                return folder;
                // axios
                //     .post(`https://www.googleapis.com/drive/v3/files/${folder.data.id}/watch`, {
                //         id: process.env.FOLDER_WATCH_UUID, // Your channel ID.
                //         type: "web_hook",
                //         address: `${process.env.NGROK}/folderWatcher`, // Your receiving URL.
                //     }, {
                //         headers: {
                //             'Authorization': `Bearer ${process.env}`,
                //             'Content-Type': `application/json`
                //         })
                //     .then(async res => {
                //         console.log(`statusCode: ${res.statusCode}`)
                //         // console.log(res)
                //         console.log('Folder Id: ', folder.data.id);
                //         foundUser.userInfo.folderId = folder.data.id;
                //         foundUser.markModified("userInfo");
                //         await foundUser.save();
                //         return folder;
                //     })
                //     .catch(error => {
                //         console.error(error)
                //     })
            }
        });
    }

    // function to create spreadsheet
    async function createSheet(auth, msg, mongoID, participants) {
        let foundUser = await User.findOne({ userId: mongoID });
        auth.setCredentials({
            refresh_token: foundUser.userInfo.googleCreds.refresh_token
        });
        google.options({ auth });
        // create the spreadsheet
        console.log("Creating spreadsheet");
        let folderId;
        // before creating folder, check if folder exists
        if (!foundUser.userInfo.folderId) {
            console.log("Folder doesn't exist... creating")
            await createFolder(auth, "Attendify", mongoID);
        }
        else {
            console.log("Folder found");
        }

        // let pageToken = null;
        // Using the NPM module 'async'
        // async.doWhilst(function (callback) {
        //     drive.files.list({
        //         q: "mimeType='application/vnd.google-apps.folder'",
        //         fields: 'nextPageToken, files(id, name)',
        //         spaces: 'drive',
        //         pageToken: pageToken
        //     }, function (err, res) {
        //         if (err) {
        //             // Handle error
        //             console.log(err);
        //             callback(err)
        //         } else {
        //             // res.files.forEach(function (folder) {
        //             //     console.log('Found file: ', folder.name, folder.id);
        //             // });
        //             // console.log("Files " + JSON.stringify(res))
        //             // for (let folder of res.data.files) {
        //             //     console.log('Found file: ', folder.name, folder.id);
        //             //     if (foundUser.userInfo.folderId === folder.id) {
        //             //         foundFolder = true;
        //             //         break;
        //             //     }
        //             // }
        //             pageToken = res.nextPageToken;
        //             callback();
        //         }
        //     });
        // }, function () {
        //     return !!pageToken;
        // }, async function (err) {
        //     if (err) {
        //         // Handle error
        //         console.log(err);
        //     }
        //     // } else {
        //     //     // All pages fetched
        //     //     if (!foundFolder) {
        //     //         console.log("Folder not found, creating folder...");
        //     //         folderId = await createFolder(auth, "Attendify", mongoID).id;
        //     //     }
        //     //     else {
        //     //         folderId = foundUser.userInfo.folderId;
        //     //     }
        //     // }
        // })
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
                                rowCount: participants.length + 1,
                                columnCount: 4
                            }
                        }
                    }
                ]
            }
        });
        // await drive.files.update({
        //     fileId: createResponse.data.spreadsheetId,
        //     addParents: folderId,
        //     removeParents: "root"
        // });
        const fileId = createResponse.data.spreadsheetId;
        foundUser = await User.findOne({ userId: mongoID});
        console.log("The found user " + foundUser);
        drive.files.get({
            fileId: fileId,
            fields: 'parents'
        }, async function (err, file) {
            if (err) {
                // Handle error
                console.error(err);
            } else {
                // Move the file to the new folder
                foundUser = await User.findOne({ userId: mongoID });
                folderId = foundUser.userInfo.folderId;
                console.log("File ID" + fileId + "... About to add to folder: " + folderId)
                drive.files.update({
                    fileId: fileId,
                    addParents: folderId,
                    removeParents: "root",
                    fields: 'id, parents'
                }, function (err, file) {
                    if (err) {
                        // Handle error
                    } else {
                        // File moved.
                        console.log("File moved");
                    }
                });
            }
        });
        let relevantData = participants.map(p => {
            let join_times_sheet = "";
            let leave_times_sheet = "";
            for (let i = 0; i < p.join_times.length; i++) {
                join_times_sheet += p.join_times[i][1] + ", ";
                leave_times_sheet += p.leave_times[i][1] + ", ";

            }
            return [p.user_name, Math.round(p.percent_attended), join_times_sheet.slice(0, -2), leave_times_sheet.slice(0, -2)];
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
});

app.post("/folderWatcher", async (req, res) => {
    console.log("Folder watcher: " + JSON.stringify(req.headers, null, 2));
    res.status(200).send();
    if (req.header("x-goog-resource-state") === "trash") {
        console.log("Folder trashed")
        let folderId = req.header("x-goog-resource-uri");
        folderId = folderId.substring(folderId.indexOf("/v3/files/") + 10, folderId.indexOf("?"));
        let foundUser = await User.findOne({"userInfo.folderId" : folderId}).exec();
        console.log("Found user" + foundUser);
        console.log("Extracted folder ID from URI: " + folderId);
        if (foundUser) {
            await drive.channels.stop({
                resource : {
                    id: folderId,
                    resourceId: foundUser.userInfo.resourceId
                }
            });
            delete foundUser.userInfo.folderId;
            delete foundUser.userInfo.resourceId;
            console.log("Deleted user's folderId")
            console.log(foundUser);
            foundUser.markModified("userInfo");
            await foundUser.save();
        }
    }
})


app.get("/privacy", (req, res) => {
    res.sendFile(__dirname + "/public/privacy.html");
});

app.get("/google0886a4684c242703.html", (req, res) => {
    res.sendFile(__dirname + "/public/google0886a4684c242703.html");
});


if (typeof (PhusionPassenger) !== 'undefined') {
    app.listen('passenger', () => {
        console.log("Attendify app listening on Passenger");
    });
} else {
    app.listen(4000, () => {
        console.log("Attendify app listening on PORT 4000");
    });
}