const express = require("express");
const http = require("http");
const app = express();

app.use(express.json());

app.post("/", (req, res) => {
    console.log(req.body.name);
});

app.listen(80, () => {
   console.log("Connected!")
});