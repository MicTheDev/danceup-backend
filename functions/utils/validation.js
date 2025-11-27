/**
 * Validation utilities for input validation
 */

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim().toLowerCase());
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, message: string}}
 */
function validatePassword(password) {
  if (!password || typeof password !== "string") {
    return {valid: false, message: "Password is required"};
  }

  if (password.length < 8) {
    return {
      valid: false,
      message: "Password must be at least 8 characters long",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate required string field
 * @param {string} value - Value to validate
 * @param {string} fieldName - Name of the field for error message
 * @returns {{valid: boolean, message: string}}
 */
function validateRequiredString(value, fieldName) {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return {
      valid: false,
      message: `${fieldName} is required`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate state code (2 letters)
 * @param {string} state - State code to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateState(state) {
  if (!state || typeof state !== "string") {
    return {valid: false, message: "State is required"};
  }

  const stateRegex = /^[A-Za-z]{2}$/;
  if (!stateRegex.test(state.trim())) {
    return {
      valid: false,
      message: "State must be a 2-letter code",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate ZIP code (5 digits or 5+4 format)
 * @param {string} zip - ZIP code to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateZip(zip) {
  if (!zip || typeof zip !== "string") {
    return {valid: false, message: "ZIP code is required"};
  }

  const zipRegex = /^[0-9]{5}(?:[-\s][0-9]{4})?$/;
  if (!zipRegex.test(zip.trim())) {
    return {
      valid: false,
      message: "ZIP code must be 5 digits or 5+4 format",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate URL format (optional field)
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateUrl(url) {
  if (!url || url.trim().length === 0) {
    return {valid: true, message: ""}; // Optional field
  }

  try {
    new URL(url);
    return {valid: true, message: ""};
  } catch (_) {
    return {valid: false, message: "Invalid URL format"};
  }
}

/**
 * Validate membership tier
 * @param {string} membership - Membership tier to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateMembership(membership) {
  const validMemberships = ["basic", "pro", "ultimate"];
  if (!validMemberships.includes(membership)) {
    return {
      valid: false,
      message: `Membership must be one of: ${validMemberships.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate registration payload
 * @param {Object} payload - Registration data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateRegistrationPayload(payload) {
  const errors = [];

  // Email validation
  if (!isValidEmail(payload.email)) {
    errors.push({field: "email", message: "Valid email is required"});
  }

  // Password validation
  const passwordValidation = validatePassword(payload.password);
  if (!passwordValidation.valid) {
    errors.push({field: "password", message: passwordValidation.message});
  }

  // Required string fields
  const requiredFields = [
    "firstName",
    "lastName",
    "studioName",
    "studioAddressLine1",
    "city",
  ];

  requiredFields.forEach((field) => {
    const validation = validateRequiredString(
        payload[field],
        field.charAt(0).toUpperCase() + field.slice(1),
    );
    if (!validation.valid) {
      errors.push({field, message: validation.message});
    }
  });

  // State validation
  const stateValidation = validateState(payload.state);
  if (!stateValidation.valid) {
    errors.push({field: "state", message: stateValidation.message});
  }

  // ZIP validation
  const zipValidation = validateZip(payload.zip);
  if (!zipValidation.valid) {
    errors.push({field: "zip", message: zipValidation.message});
  }

  // Membership validation
  const membershipValidation = validateMembership(payload.membership);
  if (!membershipValidation.valid) {
    errors.push({
      field: "membership",
      message: membershipValidation.message,
    });
  }

  // Optional URL fields
  const urlFields = ["facebook", "instagram", "tiktok", "youtube"];
  urlFields.forEach((field) => {
    if (payload[field]) {
      const urlValidation = validateUrl(payload[field]);
      if (!urlValidation.valid) {
        errors.push({field, message: urlValidation.message});
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate login payload
 * @param {Object} payload - Login data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateLoginPayload(payload) {
  const errors = [];

  if (!isValidEmail(payload.email)) {
    errors.push({field: "email", message: "Valid email is required"});
  }

  if (!payload.password || payload.password.trim().length === 0) {
    errors.push({field: "password", message: "Password is required"});
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  isValidEmail,
  validatePassword,
  validateRequiredString,
  validateState,
  validateZip,
  validateUrl,
  validateMembership,
  validateRegistrationPayload,
  validateLoginPayload,
};


