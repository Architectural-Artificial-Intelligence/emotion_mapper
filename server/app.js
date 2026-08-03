#!/usr/bin/env node

/**
 * server/app.js
 * Express entrypoint for the Emotion Mapper prototype web server.
 */

const express = require('express');
const path = require('path');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/', routes);

app.listen(PORT, () => {
  console.log(`Emotion Mapper server listening on http://localhost:${PORT}`);
});

module.exports = app;
