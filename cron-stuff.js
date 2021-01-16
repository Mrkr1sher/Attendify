const cron = require('node-cron');
const express = require('express');

app = express();

cron.schedule('*/2 * * * *', function() {
    console.log('running a task two minutes');
});

app.listen(3000);