const {getFirestore} = require("../utils/firestore");

const COLLECTION = "emailTemplates";

/**
 * Save a new email template for a studio owner.
 * @param {string} studioOwnerId
 * @param {string} name
 * @param {Object} design - Unlayer JSON design
 * @param {string} html - Rendered HTML preview
 * @returns {Promise<string>} New template ID
 */
async function saveTemplate(studioOwnerId, name, design, html) {
  const db = getFirestore();
  const ref = await db.collection(COLLECTION).add({
    studioOwnerId,
    name,
    design,
    html,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return ref.id;
}

/**
 * Update an existing template's design and HTML.
 * @param {string} templateId
 * @param {string} studioOwnerId
 * @param {string} name
 * @param {Object} design
 * @param {string} html
 */
async function updateTemplate(templateId, studioOwnerId, name, design, html) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(templateId);
  const doc = await ref.get();
  if (!doc.exists || doc.data().studioOwnerId !== studioOwnerId) {
    throw new Error("Template not found or access denied");
  }
  await ref.update({name, design, html, updatedAt: new Date().toISOString()});
}

/**
 * List all templates for a studio owner (metadata only, no design JSON).
 * @param {string} studioOwnerId
 * @returns {Promise<Array>}
 */
async function listTemplates(studioOwnerId) {
  const db = getFirestore();
  const snap = await db
      .collection(COLLECTION)
      .where("studioOwnerId", "==", studioOwnerId)
      .orderBy("updatedAt", "desc")
      .get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    html: doc.data().html || "",
    createdAt: doc.data().createdAt,
    updatedAt: doc.data().updatedAt,
  }));
}

/**
 * Get a single template including its design JSON.
 * @param {string} templateId
 * @param {string} studioOwnerId
 * @returns {Promise<Object|null>}
 */
async function getTemplate(templateId, studioOwnerId) {
  const db = getFirestore();
  const doc = await db.collection(COLLECTION).doc(templateId).get();
  if (!doc.exists || doc.data().studioOwnerId !== studioOwnerId) return null;
  return {id: doc.id, ...doc.data()};
}

/**
 * Delete a template.
 * @param {string} templateId
 * @param {string} studioOwnerId
 */
async function deleteTemplate(templateId, studioOwnerId) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(templateId);
  const doc = await ref.get();
  if (!doc.exists || doc.data().studioOwnerId !== studioOwnerId) {
    throw new Error("Template not found or access denied");
  }
  await ref.delete();
}

module.exports = {saveTemplate, updateTemplate, listTemplates, getTemplate, deleteTemplate};
