const admin = require("firebase-admin");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Export grouped Express apps
exports.auth = require("./auth").auth;
exports.profile = require("./profile").profile;
exports.classes = require("./classes").classes;
exports.instructors = require("./instructors").instructors;
exports.workshops = require("./workshops").workshops;
exports.events = require("./events").events;
exports.packages = require("./packages").packages;
exports.support = require("./support").support;
exports.attendance = require("./attendance").attendance;
