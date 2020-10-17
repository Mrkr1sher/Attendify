// Bring in environment secrets through dotenv
require('dotenv/config')
const fs = require('fs');
// Use the request module to make HTTP requests from Node
const request = require('request')

// Run the express app
const express = require('express')
const app = express()

const VERIFICATION_TOKEN = "nmuI2NTJSJK6nn1iHzUpUw";

let meetings = [];

app.use(express.json());

app.get('/', (req, res) => {

    // Step 1: 
    // Check if the code parameter is in the url 
    // if an authorization code is available, the user has most likely been redirected from Zoom OAuth
    // if not, the user needs to be redirected to Zoom OAuth to authorize
    if (req.query.code) {
        console.log(req.query.code);
        // Step 3: 
        // Request an access token using the auth code

        let url = 'https://zoom.us/oauth/token?grant_type=authorization_code&code=' + req.query.code + '&redirect_uri=' + process.env.redirectURL;

        request.post(url, (error, response, body) => {
            console.log(body);
            // Parse response to JSON
            body = JSON.parse(body);

            // Logs your access and refresh tokens in the browser
            console.log(`access_token: ${body.access_token}`);
            console.log(`refresh_token: ${body.refresh_token}`);

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
                        body = JSON.parse(body);
                        // Display response in console
                        console.log('API call ', body);
                        // Display response in browser
                        var JSONResponse = '<pre><code>' + JSON.stringify(body, null, 2) + '</code></pre>'
                        res.send(`
                            <style>
                                @import url('https://fonts.googleapis.com/css?family=Open+Sans:400,600&display=swap');@import url('https://necolas.github.io/normalize.css/8.0.1/normalize.css');html {color: #232333;font-family: 'Open Sans', Helvetica, Arial, sans-serif;-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;}h2 {font-weight: 700;font-size: 24px;}h4 {font-weight: 600;font-size: 14px;}.container {margin: 24px auto;padding: 16px;max-width: 720px;}.info {display: flex;align-items: center;}.info>div>span, .info>div>p {font-weight: 400;font-size: 13px;color: #747487;line-height: 16px;}.info>div>span::before {content: "👋";}.info>div>h2 {padding: 8px 0 6px;margin: 0;}.info>div>p {padding: 0;margin: 0;}.info>img {background: #747487;height: 96px;width: 96px;border-radius: 31.68px;overflow: hidden;margin: 0 20px 0 0;}.response {margin: 32px 0;display: flex;flex-wrap: wrap;align-items: center;justify-content: space-between;}.response>a {text-decoration: none;color: #2D8CFF;font-size: 14px;}.response>pre {overflow-x: scroll;background: #f6f7f9;padding: 1.2em 1.4em;border-radius: 10.56px;width: 100%;box-sizing: border-box;}
                            </style>
                            <div class="container">
                                <div class="info">
                                    <img src="${body.pic_url}" alt="User photo" />
                                    <div>
                                        <span>Hello World!</span>
                                        <h2>${body.first_name} ${body.last_name}</h2>
                                        <p>${body.role_name}, ${body.company}</p>
                                    </div>
                                </div>
                                <div class="response">
                                    <h4>JSON Response:</h4>
                                    <a href="https://marketplace.zoom.us/docs/api-reference/zoom-api/users/user" target="_blank">
                                        API Reference
                                    </a>
                                    ${JSONResponse}
                                </div>
                            </div>
                        `);
                    }
                }).auth(null, null, true, body.access_token);

            } else {
                // Handle errors, something's gone wrong!
            }

        }).auth(process.env.clientID, process.env.clientSecret);

        return;

    }

    // Step 2: 
    // If no authorization code is available, redirect to Zoom OAuth to authorize
    res.redirect('https://zoom.us/oauth/authorize?response_type=code&client_id=' + process.env.clientID + '&redirect_uri=' + process.env.redirectURL)
});

// Set up a webhook listener for Webhook Event
app.post('/', (req, res) => {
    res.status(200);
    let webhook;
    try {
        webhook = req.body;
    } catch (err) {
        console.log(`Webhook Error: ${err.message}`);
    }
    // Check to see if you received the event or not.
    if (req.headers.authorization === VERIFICATION_TOKEN) {
        switch (webhook.event){
            case "meeting.started":
                console.log(`${webhook.payload.object.topic} started at time ${webhook.payload.object.start_time}`);
                let meeting = webhook.payload.object;
                meeting.participants = [];
                meetings.push(meeting);
                break;
            case "meeting.ended":
                console.log(`${webhook.payload.object.topic} ended at time ${webhook.payload.object.end_time}`);
                for (let meeting of meetings){
                    if (meeting.uuid === webhook.payload.object.uuid){
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
                for (let meeting of meetings){
                    if (meeting.uuid === webhook.payload.object.uuid){
                        meeting.participants.push(webhook.payload.object.participant);
                    }
                }
                break;
            case "meeting.participant_left":
                console.log(`${webhook.payload.object.participant.user_name} left ${webhook.payload.object.topic} at time ${webhook.payload.object.participant.leave_time}`);
                for (let meeting of meetings){
                    if (meeting.uuid === webhook.payload.object.uuid){
                        for (let participant of meeting.participants){
                            if (participant.user_id === webhook.payload.object.participant.user_id) {
                                participant.leave_time = webhook.payload.object.participant.leave_time;
                            }
                        }
                    }
                }
                break;
        }
        // let filename = `${webhook.event}.json`;
        // fs.writeFile(filename, JSON.stringify(webhook, null, 2), (err) => {
        //     if (err) throw err;
        //     console.log('File Saved!');
        // });
    }
});


app.listen(4000, () => console.log(`Zoom app listening at PORT: 4000`))