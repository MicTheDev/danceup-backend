
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
exports.packagePurchases = require("./package-purchases").packagePurchases;
exports.support = require("./support").support;
exports.attendance = require("./attendance").attendance;
exports.students = require("./students").students;
exports.usersstudent = require("./usersStudent").usersstudent;
exports.studios = require("./studios").studios;
exports.bookings = require("./bookings").bookings;
exports.notifications = require("./notifications").notifications;
exports.updateClassImages = require("./updateClassImages").updateClassImages;
exports.expireCredits = require("./credit-expiration").expireCredits;
exports.expireCreditsManual = require("./credit-expiration").expireCreditsManual;
exports.stripe = require("./stripe").stripe;
exports.purchases = require("./purchases").purchases;
exports.reviews = require("./reviews").reviews;
exports.marketing = require("./marketing").marketing;
exports.emailTemplates = require("./email-templates").emailTemplates;