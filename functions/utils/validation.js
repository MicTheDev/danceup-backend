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

/**
 * Validate time format (HH:mm)
 * @param {string} time - Time string to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateTimeFormat(time) {
  if (!time || typeof time !== "string") {
    return {valid: false, message: "Time is required"};
  }

  const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(time.trim())) {
    return {valid: false, message: "Time must be in HH:mm format (24-hour)"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate class level
 * @param {string} level - Class level to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateClassLevel(level) {
  const validLevels = ["Beginner", "Intermediate", "Advanced", "All Levels"];
  if (!level || !validLevels.includes(level)) {
    return {
      valid: false,
      message: `Level must be one of: ${validLevels.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate day of week
 * @param {string} dayOfWeek - Day of week to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateDayOfWeek(dayOfWeek) {
  const validDays = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  if (!dayOfWeek || !validDays.includes(dayOfWeek)) {
    return {
      valid: false,
      message: `Day of week must be one of: ${validDays.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate cost
 * @param {number} cost - Cost to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateCost(cost) {
  if (cost === undefined || cost === null) {
    return {valid: false, message: "Cost is required"};
  }

  if (typeof cost !== "number" || isNaN(cost)) {
    return {valid: false, message: "Cost must be a number"};
  }

  if (cost < 0) {
    return {valid: false, message: "Cost must be greater than or equal to 0"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate instructor IDs array
 * @param {Array} instructorIds - Instructor IDs to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateInstructorIds(instructorIds) {
  if (instructorIds === undefined || instructorIds === null) {
    return {valid: false, message: "Instructor IDs are required"};
  }

  if (!Array.isArray(instructorIds)) {
    return {valid: false, message: "Instructor IDs must be an array"};
  }

  // All items should be strings
  if (!instructorIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return {valid: false, message: "All instructor IDs must be non-empty strings"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate create class payload
 * @param {Object} payload - Class data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateClassPayload(payload) {
  const errors = [];

  // Name validation
  const nameValidation = validateRequiredString(payload.name, "Name");
  if (!nameValidation.valid) {
    errors.push({field: "name", message: nameValidation.message});
  }

  // Level validation
  const levelValidation = validateClassLevel(payload.level);
  if (!levelValidation.valid) {
    errors.push({field: "level", message: levelValidation.message});
  }

  // Cost validation
  const costValidation = validateCost(payload.cost);
  if (!costValidation.valid) {
    errors.push({field: "cost", message: costValidation.message});
  }

  // Day of week validation
  const dayValidation = validateDayOfWeek(payload.dayOfWeek);
  if (!dayValidation.valid) {
    errors.push({field: "dayOfWeek", message: dayValidation.message});
  }

  // Start time validation
  const startTimeValidation = validateTimeFormat(payload.startTime);
  if (!startTimeValidation.valid) {
    errors.push({field: "startTime", message: startTimeValidation.message});
  }

  // End time validation
  const endTimeValidation = validateTimeFormat(payload.endTime);
  if (!endTimeValidation.valid) {
    errors.push({field: "endTime", message: endTimeValidation.message});
  }

  // Instructor IDs validation
  const instructorIdsValidation = validateInstructorIds(payload.instructorIds);
  if (!instructorIdsValidation.valid) {
    errors.push({field: "instructorIds", message: instructorIdsValidation.message});
  }

  // IsActive validation
  if (payload.isActive === undefined || payload.isActive === null) {
    errors.push({field: "isActive", message: "IsActive is required"});
  } else if (typeof payload.isActive !== "boolean") {
    errors.push({field: "isActive", message: "IsActive must be a boolean"});
  }

  // Optional description validation
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  // Optional room validation
  if (payload.room !== undefined && payload.room !== null) {
    if (typeof payload.room !== "string") {
      errors.push({field: "room", message: "Room must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update class payload
 * @param {Object} payload - Class update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateClassPayload(payload) {
  const errors = [];

  // Name validation (optional for update)
  if (payload.name !== undefined) {
    const nameValidation = validateRequiredString(payload.name, "Name");
    if (!nameValidation.valid) {
      errors.push({field: "name", message: nameValidation.message});
    }
  }

  // Level validation (optional for update)
  if (payload.level !== undefined) {
    const levelValidation = validateClassLevel(payload.level);
    if (!levelValidation.valid) {
      errors.push({field: "level", message: levelValidation.message});
    }
  }

  // Cost validation (optional for update)
  if (payload.cost !== undefined) {
    const costValidation = validateCost(payload.cost);
    if (!costValidation.valid) {
      errors.push({field: "cost", message: costValidation.message});
    }
  }

  // Day of week validation (optional for update)
  if (payload.dayOfWeek !== undefined) {
    const dayValidation = validateDayOfWeek(payload.dayOfWeek);
    if (!dayValidation.valid) {
      errors.push({field: "dayOfWeek", message: dayValidation.message});
    }
  }

  // Start time validation (optional for update)
  if (payload.startTime !== undefined) {
    const startTimeValidation = validateTimeFormat(payload.startTime);
    if (!startTimeValidation.valid) {
      errors.push({field: "startTime", message: startTimeValidation.message});
    }
  }

  // End time validation (optional for update)
  if (payload.endTime !== undefined) {
    const endTimeValidation = validateTimeFormat(payload.endTime);
    if (!endTimeValidation.valid) {
      errors.push({field: "endTime", message: endTimeValidation.message});
    }
  }

  // Instructor IDs validation (optional for update)
  if (payload.instructorIds !== undefined) {
    const instructorIdsValidation = validateInstructorIds(payload.instructorIds);
    if (!instructorIdsValidation.valid) {
      errors.push({field: "instructorIds", message: instructorIdsValidation.message});
    }
  }

  // IsActive validation (optional for update)
  if (payload.isActive !== undefined && payload.isActive !== null) {
    if (typeof payload.isActive !== "boolean") {
      errors.push({field: "isActive", message: "IsActive must be a boolean"});
    }
  }

  // Optional description validation
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  // Optional room validation
  if (payload.room !== undefined && payload.room !== null) {
    if (typeof payload.room !== "string") {
      errors.push({field: "room", message: "Room must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate phone number format (optional)
 * @param {string} phone - Phone number to validate
 * @returns {{valid: boolean, message: string}}
 */
function validatePhone(phone) {
  if (!phone || phone.trim().length === 0) {
    return {valid: true, message: ""}; // Optional field
  }

  // Basic phone validation - allows various formats
  const phoneRegex = /^[\d\s\-\(\)\+\.]+$/;
  if (!phoneRegex.test(phone.trim())) {
    return {valid: false, message: "Invalid phone number format"};
  }

  // Remove all non-digits and check length
  const digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return {valid: false, message: "Phone number must be between 10 and 15 digits"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate time format (HH:mm)
 * @param {string} time - Time string
 * @returns {boolean}
 */
function isValidTimeFormat(time) {
  if (typeof time !== "string") {
    return false;
  }
  const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
}

/**
 * Validate time slot
 * @param {Object} timeSlot - Time slot object
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateTimeSlot(timeSlot) {
  const errors = [];

  if (!timeSlot || typeof timeSlot !== "object") {
    errors.push({field: "timeSlot", message: "Time slot must be an object"});
    return {valid: false, errors};
  }

  // Validate startTime
  if (!timeSlot.startTime || typeof timeSlot.startTime !== "string") {
    errors.push({field: "startTime", message: "Start time is required and must be a string"});
  } else if (!isValidTimeFormat(timeSlot.startTime)) {
    errors.push({field: "startTime", message: "Start time must be in HH:mm format"});
  }

  // Validate endTime
  if (!timeSlot.endTime || typeof timeSlot.endTime !== "string") {
    errors.push({field: "endTime", message: "End time is required and must be a string"});
  } else if (!isValidTimeFormat(timeSlot.endTime)) {
    errors.push({field: "endTime", message: "End time must be in HH:mm format"});
  }

  // Validate end time is after start time
  if (timeSlot.startTime && timeSlot.endTime && isValidTimeFormat(timeSlot.startTime) && isValidTimeFormat(timeSlot.endTime)) {
    const [startHours, startMinutes] = timeSlot.startTime.split(":").map(Number);
    const [endHours, endMinutes] = timeSlot.endTime.split(":").map(Number);
    const startTotal = startHours * 60 + startMinutes;
    const endTotal = endHours * 60 + endMinutes;

    if (endTotal <= startTotal) {
      errors.push({field: "endTime", message: "End time must be after start time"});
    }

    // Validate that it's exactly 1 hour (for 1-hour block system)
    const duration = endTotal - startTotal;
    if (duration !== 60) {
      errors.push({field: "duration", message: "Time slot must be exactly 1 hour"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate day availability
 * @param {Object} dayAvail - Day availability object
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateDayAvailability(dayAvail) {
  const errors = [];
  const validDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  // Day validation
  if (!dayAvail.day || typeof dayAvail.day !== "string") {
    errors.push({field: "day", message: "Day is required and must be a string"});
  } else if (!validDays.includes(dayAvail.day.toLowerCase())) {
    errors.push({field: "day", message: `Day must be one of: ${validDays.join(", ")}`});
  }

  // Available flag validation
  if (dayAvail.available !== undefined && typeof dayAvail.available !== "boolean") {
    errors.push({field: "available", message: "Available must be a boolean"});
  }

  // If available is true, validate time slots or legacy times
  if (dayAvail.available === true) {
    // New format: validate timeSlots array
    if (dayAvail.timeSlots !== undefined && dayAvail.timeSlots !== null) {
      if (!Array.isArray(dayAvail.timeSlots)) {
        errors.push({field: "timeSlots", message: "Time slots must be an array"});
      } else {
        // Validate each time slot
        dayAvail.timeSlots.forEach((slot, index) => {
          const slotValidation = validateTimeSlot(slot);
          if (!slotValidation.valid) {
            slotValidation.errors.forEach((err) => {
              errors.push({field: `timeSlots[${index}].${err.field}`, message: err.message});
            });
          }
        });

        // Check for overlapping time slots
        const sortedSlots = [...dayAvail.timeSlots].sort((a, b) => {
          const [aHours, aMinutes] = a.startTime.split(":").map(Number);
          const [bHours, bMinutes] = b.startTime.split(":").map(Number);
          return (aHours * 60 + aMinutes) - (bHours * 60 + bMinutes);
        });

        for (let i = 0; i < sortedSlots.length - 1; i++) {
          const currentEnd = sortedSlots[i].endTime.split(":").map(Number);
          const nextStart = sortedSlots[i + 1].startTime.split(":").map(Number);
          const currentEndTotal = currentEnd[0] * 60 + currentEnd[1];
          const nextStartTotal = nextStart[0] * 60 + nextStart[1];

          if (nextStartTotal < currentEndTotal) {
            errors.push({field: "timeSlots", message: "Time slots cannot overlap"});
            break;
          }
        }
      }
    }
    // Legacy format: validate startTime/endTime (for backward compatibility)
    else if (dayAvail.startTime !== undefined || dayAvail.endTime !== undefined) {
      if (dayAvail.startTime !== undefined && dayAvail.startTime !== null) {
        if (!isValidTimeFormat(dayAvail.startTime)) {
          errors.push({field: "startTime", message: "Start time must be in HH:mm format"});
        }
      }

      if (dayAvail.endTime !== undefined && dayAvail.endTime !== null) {
        if (!isValidTimeFormat(dayAvail.endTime)) {
          errors.push({field: "endTime", message: "End time must be in HH:mm format"});
        }
      }

      // Validate end time is after start time
      if (dayAvail.startTime && dayAvail.endTime && isValidTimeFormat(dayAvail.startTime) && isValidTimeFormat(dayAvail.endTime)) {
        const [startHours, startMinutes] = dayAvail.startTime.split(":").map(Number);
        const [endHours, endMinutes] = dayAvail.endTime.split(":").map(Number);
        const startTotal = startHours * 60 + startMinutes;
        const endTotal = endHours * 60 + endMinutes;

        if (endTotal <= startTotal) {
          errors.push({field: "endTime", message: "End time must be after start time"});
        }
      }
    } else {
      // If available is true but no time slots or times provided
      errors.push({field: "timeSlots", message: "Time slots or start/end time required when available is true"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate instructor availability
 * @param {Object} availability - Availability object
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateInstructorAvailability(availability) {
  const errors = [];

  // availableForPrivates validation
  if (availability.availableForPrivates !== undefined && typeof availability.availableForPrivates !== "boolean") {
    errors.push({field: "availableForPrivates", message: "availableForPrivates must be a boolean"});
  }

  // availability array validation (optional)
  if (availability.availability !== undefined && availability.availability !== null) {
    if (!Array.isArray(availability.availability)) {
      errors.push({field: "availability", message: "Availability must be an array"});
    } else {
      availability.availability.forEach((dayAvail, index) => {
        const dayValidation = validateDayAvailability(dayAvail);
        if (!dayValidation.valid) {
          dayValidation.errors.forEach((err) => {
            errors.push({field: `availability[${index}].${err.field}`, message: err.message});
          });
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate create instructor payload
 * @param {Object} payload - Instructor data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateInstructorPayload(payload) {
  const errors = [];

  // First name validation
  const firstNameValidation = validateRequiredString(payload.firstName, "First name");
  if (!firstNameValidation.valid) {
    errors.push({field: "firstName", message: firstNameValidation.message});
  }

  // Last name validation
  const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
  if (!lastNameValidation.valid) {
    errors.push({field: "lastName", message: lastNameValidation.message});
  }

  // Email validation (optional)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Bio validation (optional)
  if (payload.bio !== undefined && payload.bio !== null) {
    if (typeof payload.bio !== "string") {
      errors.push({field: "bio", message: "Bio must be a string"});
    }
  }

  // Photo URL validation (optional, usually set by backend after upload)
  if (payload.photoUrl !== undefined && payload.photoUrl !== null) {
    if (typeof payload.photoUrl !== "string") {
      errors.push({field: "photoUrl", message: "Photo URL must be a string"});
    }
  }

  // Availability validation (optional)
  if (payload.availability !== undefined && payload.availability !== null) {
    const availabilityValidation = validateInstructorAvailability(payload.availability);
    if (!availabilityValidation.valid) {
      errors.push(...availabilityValidation.errors.map((err) => ({
        field: `availability.${err.field}`,
        message: err.message,
      })));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update instructor payload
 * @param {Object} payload - Instructor update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateInstructorPayload(payload) {
  const errors = [];

  // First name validation (optional for update)
  if (payload.firstName !== undefined) {
    const firstNameValidation = validateRequiredString(payload.firstName, "First name");
    if (!firstNameValidation.valid) {
      errors.push({field: "firstName", message: firstNameValidation.message});
    }
  }

  // Last name validation (optional for update)
  if (payload.lastName !== undefined) {
    const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
    if (!lastNameValidation.valid) {
      errors.push({field: "lastName", message: lastNameValidation.message});
    }
  }

  // Email validation (optional for update)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional for update)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Bio validation (optional for update)
  if (payload.bio !== undefined && payload.bio !== null) {
    if (typeof payload.bio !== "string") {
      errors.push({field: "bio", message: "Bio must be a string"});
    }
  }

  // Photo URL validation (optional for update)
  if (payload.photoUrl !== undefined && payload.photoUrl !== null) {
    if (typeof payload.photoUrl !== "string") {
      errors.push({field: "photoUrl", message: "Photo URL must be a string"});
    }
  }

  // Availability validation (optional for update)
  if (payload.availability !== undefined && payload.availability !== null) {
    const availabilityValidation = validateInstructorAvailability(payload.availability);
    if (!availabilityValidation.valid) {
      errors.push(...availabilityValidation.errors.map((err) => ({
        field: `availability.${err.field}`,
        message: err.message,
      })));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update profile payload
 * @param {Object} payload - Profile update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateProfilePayload(payload) {
  const errors = [];

  // First name validation (optional for update)
  if (payload.firstName !== undefined) {
    const firstNameValidation = validateRequiredString(payload.firstName, "First name");
    if (!firstNameValidation.valid) {
      errors.push({field: "firstName", message: firstNameValidation.message});
    }
  }

  // Last name validation (optional for update)
  if (payload.lastName !== undefined) {
    const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
    if (!lastNameValidation.valid) {
      errors.push({field: "lastName", message: lastNameValidation.message});
    }
  }

  // Studio name validation (optional for update)
  if (payload.studioName !== undefined) {
    const studioNameValidation = validateRequiredString(payload.studioName, "Studio name");
    if (!studioNameValidation.valid) {
      errors.push({field: "studioName", message: studioNameValidation.message});
    }
  }

  // Studio address line 1 validation (optional for update)
  if (payload.studioAddressLine1 !== undefined) {
    const addressValidation = validateRequiredString(payload.studioAddressLine1, "Studio address line 1");
    if (!addressValidation.valid) {
      errors.push({field: "studioAddressLine1", message: addressValidation.message});
    }
  }

  // Studio address line 2 validation (optional, can be null or empty)
  if (payload.studioAddressLine2 !== undefined && payload.studioAddressLine2 !== null) {
    if (typeof payload.studioAddressLine2 !== "string") {
      errors.push({field: "studioAddressLine2", message: "Studio address line 2 must be a string"});
    }
  }

  // City validation (optional for update)
  if (payload.city !== undefined) {
    const cityValidation = validateRequiredString(payload.city, "City");
    if (!cityValidation.valid) {
      errors.push({field: "city", message: cityValidation.message});
    }
  }

  // State validation (optional for update)
  if (payload.state !== undefined) {
    const stateValidation = validateState(payload.state);
    if (!stateValidation.valid) {
      errors.push({field: "state", message: stateValidation.message});
    }
  }

  // ZIP validation (optional for update)
  if (payload.zip !== undefined) {
    const zipValidation = validateZip(payload.zip);
    if (!zipValidation.valid) {
      errors.push({field: "zip", message: zipValidation.message});
    }
  }

  // Social media URL validations (all optional)
  if (payload.facebook !== undefined && payload.facebook !== null && payload.facebook.trim() !== "") {
    const facebookValidation = validateUrl(payload.facebook);
    if (!facebookValidation.valid) {
      errors.push({field: "facebook", message: facebookValidation.message});
    }
  }

  if (payload.instagram !== undefined && payload.instagram !== null && payload.instagram.trim() !== "") {
    const instagramValidation = validateUrl(payload.instagram);
    if (!instagramValidation.valid) {
      errors.push({field: "instagram", message: instagramValidation.message});
    }
  }

  if (payload.tiktok !== undefined && payload.tiktok !== null && payload.tiktok.trim() !== "") {
    const tiktokValidation = validateUrl(payload.tiktok);
    if (!tiktokValidation.valid) {
      errors.push({field: "tiktok", message: tiktokValidation.message});
    }
  }

  if (payload.youtube !== undefined && payload.youtube !== null && payload.youtube.trim() !== "") {
    const youtubeValidation = validateUrl(payload.youtube);
    if (!youtubeValidation.valid) {
      errors.push({field: "youtube", message: youtubeValidation.message});
    }
  }

  // Studio image file validation (optional, base64 string)
  if (payload.studioImageFile !== undefined && payload.studioImageFile !== null) {
    if (typeof payload.studioImageFile !== "string") {
      errors.push({field: "studioImageFile", message: "Studio image file must be a base64 string"});
    } else if (!payload.studioImageFile.startsWith("data:image/")) {
      errors.push({field: "studioImageFile", message: "Studio image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate workshop level
 * @param {string} level - Workshop level to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateWorkshopLevel(level) {
  const validLevels = ["beginner", "intermediate", "advanced"];
  if (!level || !validLevels.includes(level.toLowerCase())) {
    return {
      valid: false,
      message: `Level must be one of: ${validLevels.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate workshop levels array
 * @param {Array} levels - Workshop levels to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateWorkshopLevels(levels) {
  if (levels === undefined || levels === null) {
    return {valid: false, message: "Levels are required"};
  }

  if (!Array.isArray(levels) || levels.length === 0) {
    return {valid: false, message: "Levels must be a non-empty array"};
  }

  for (const level of levels) {
    const levelValidation = validateWorkshopLevel(level);
    if (!levelValidation.valid) {
      return {valid: false, message: levelValidation.message};
    }
  }

  return {valid: true, message: ""};
}

/**
 * Validate ISO datetime string
 * @param {string} dateTime - ISO datetime string to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateISODateTime(dateTime) {
  if (!dateTime || typeof dateTime !== "string") {
    return {valid: false, message: "DateTime is required"};
  }

  const date = new Date(dateTime);
  if (isNaN(date.getTime())) {
    return {valid: false, message: "DateTime must be a valid ISO datetime string"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate price tier
 * @param {Object} tier - Price tier object
 * @returns {{valid: boolean, message: string}}
 */
function validatePriceTier(tier) {
  if (!tier || typeof tier !== "object") {
    return {valid: false, message: "Price tier must be an object"};
  }

  if (!tier.name || typeof tier.name !== "string" || tier.name.trim().length === 0) {
    return {valid: false, message: "Price tier name is required"};
  }

  if (tier.price === undefined || tier.price === null || typeof tier.price !== "number" || tier.price < 0) {
    return {valid: false, message: "Price tier price must be a non-negative number"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate price tiers array
 * @param {Array} priceTiers - Price tiers to validate
 * @returns {{valid: boolean, message: string}}
 */
function validatePriceTiers(priceTiers) {
  if (priceTiers === undefined || priceTiers === null) {
    return {valid: false, message: "Price tiers are required"};
  }

  if (!Array.isArray(priceTiers) || priceTiers.length === 0) {
    return {valid: false, message: "Price tiers must be a non-empty array"};
  }

  for (let i = 0; i < priceTiers.length; i++) {
    const tierValidation = validatePriceTier(priceTiers[i]);
    if (!tierValidation.valid) {
      return {valid: false, message: `Price tier ${i + 1}: ${tierValidation.message}`};
    }
  }

  return {valid: true, message: ""};
}

/**
 * Validate event type
 * @param {string} type - Event type to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateEventType(type) {
  const validTypes = ["social", "festival", "congress"];
  if (!type || !validTypes.includes(type.toLowerCase())) {
    return {
      valid: false,
      message: `Event type must be one of: ${validTypes.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate create workshop payload
 * @param {Object} payload - Workshop data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateWorkshopPayload(payload) {
  const errors = [];

  // Name validation
  const nameValidation = validateRequiredString(payload.name, "Name");
  if (!nameValidation.valid) {
    errors.push({field: "name", message: nameValidation.message});
  }

  // Levels validation
  const levelsValidation = validateWorkshopLevels(payload.levels);
  if (!levelsValidation.valid) {
    errors.push({field: "levels", message: levelsValidation.message});
  }

  // Start time validation
  const startTimeValidation = validateISODateTime(payload.startTime);
  if (!startTimeValidation.valid) {
    errors.push({field: "startTime", message: startTimeValidation.message});
  }

  // End time validation
  const endTimeValidation = validateISODateTime(payload.endTime);
  if (!endTimeValidation.valid) {
    errors.push({field: "endTime", message: endTimeValidation.message});
  }

  // Price tiers validation
  const priceTiersValidation = validatePriceTiers(payload.priceTiers);
  if (!priceTiersValidation.valid) {
    errors.push({field: "priceTiers", message: priceTiersValidation.message});
  }

  // Address validation
  const addressLine1Validation = validateRequiredString(payload.addressLine1, "Address line 1");
  if (!addressLine1Validation.valid) {
    errors.push({field: "addressLine1", message: addressLine1Validation.message});
  }

  const cityValidation = validateRequiredString(payload.city, "City");
  if (!cityValidation.valid) {
    errors.push({field: "city", message: cityValidation.message});
  }

  const stateValidation = validateState(payload.state);
  if (!stateValidation.valid) {
    errors.push({field: "state", message: stateValidation.message});
  }

  const zipValidation = validateZip(payload.zip);
  if (!zipValidation.valid) {
    errors.push({field: "zip", message: zipValidation.message});
  }

  // Description validation (optional)
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  // Address line 2 validation (optional)
  if (payload.addressLine2 !== undefined && payload.addressLine2 !== null) {
    if (typeof payload.addressLine2 !== "string") {
      errors.push({field: "addressLine2", message: "Address line 2 must be a string"});
    }
  }

  // Location name validation (optional)
  if (payload.locationName !== undefined && payload.locationName !== null) {
    if (typeof payload.locationName !== "string") {
      errors.push({field: "locationName", message: "Location name must be a string"});
    }
  }

  // Image file validation (optional, base64 string)
  if (payload.imageFile !== undefined && payload.imageFile !== null) {
    if (typeof payload.imageFile !== "string") {
      errors.push({field: "imageFile", message: "Image file must be a base64 string"});
    } else if (!payload.imageFile.startsWith("data:image/")) {
      errors.push({field: "imageFile", message: "Image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update workshop payload
 * @param {Object} payload - Workshop update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateWorkshopPayload(payload) {
  const errors = [];

  // Name validation (optional for update)
  if (payload.name !== undefined) {
    const nameValidation = validateRequiredString(payload.name, "Name");
    if (!nameValidation.valid) {
      errors.push({field: "name", message: nameValidation.message});
    }
  }

  // Levels validation (optional for update)
  if (payload.levels !== undefined) {
    const levelsValidation = validateWorkshopLevels(payload.levels);
    if (!levelsValidation.valid) {
      errors.push({field: "levels", message: levelsValidation.message});
    }
  }

  // Start time validation (optional for update)
  if (payload.startTime !== undefined) {
    const startTimeValidation = validateISODateTime(payload.startTime);
    if (!startTimeValidation.valid) {
      errors.push({field: "startTime", message: startTimeValidation.message});
    }
  }

  // End time validation (optional for update)
  if (payload.endTime !== undefined) {
    const endTimeValidation = validateISODateTime(payload.endTime);
    if (!endTimeValidation.valid) {
      errors.push({field: "endTime", message: endTimeValidation.message});
    }
  }

  // Price tiers validation (optional for update)
  if (payload.priceTiers !== undefined) {
    const priceTiersValidation = validatePriceTiers(payload.priceTiers);
    if (!priceTiersValidation.valid) {
      errors.push({field: "priceTiers", message: priceTiersValidation.message});
    }
  }

  // Address validation (optional for update)
  if (payload.addressLine1 !== undefined) {
    const addressLine1Validation = validateRequiredString(payload.addressLine1, "Address line 1");
    if (!addressLine1Validation.valid) {
      errors.push({field: "addressLine1", message: addressLine1Validation.message});
    }
  }

  if (payload.city !== undefined) {
    const cityValidation = validateRequiredString(payload.city, "City");
    if (!cityValidation.valid) {
      errors.push({field: "city", message: cityValidation.message});
    }
  }

  if (payload.state !== undefined) {
    const stateValidation = validateState(payload.state);
    if (!stateValidation.valid) {
      errors.push({field: "state", message: stateValidation.message});
    }
  }

  if (payload.zip !== undefined) {
    const zipValidation = validateZip(payload.zip);
    if (!zipValidation.valid) {
      errors.push({field: "zip", message: zipValidation.message});
    }
  }

  // Optional fields
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  if (payload.addressLine2 !== undefined && payload.addressLine2 !== null) {
    if (typeof payload.addressLine2 !== "string") {
      errors.push({field: "addressLine2", message: "Address line 2 must be a string"});
    }
  }

  if (payload.locationName !== undefined && payload.locationName !== null) {
    if (typeof payload.locationName !== "string") {
      errors.push({field: "locationName", message: "Location name must be a string"});
    }
  }

  // Image file validation (optional, base64 string)
  if (payload.imageFile !== undefined && payload.imageFile !== null) {
    if (typeof payload.imageFile !== "string") {
      errors.push({field: "imageFile", message: "Image file must be a base64 string"});
    } else if (!payload.imageFile.startsWith("data:image/")) {
      errors.push({field: "imageFile", message: "Image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate create event payload
 * @param {Object} payload - Event data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateEventPayload(payload) {
  const errors = [];

  // Name validation
  const nameValidation = validateRequiredString(payload.name, "Name");
  if (!nameValidation.valid) {
    errors.push({field: "name", message: nameValidation.message});
  }

  // Type validation
  const typeValidation = validateEventType(payload.type);
  if (!typeValidation.valid) {
    errors.push({field: "type", message: typeValidation.message});
  }

  // Start time validation
  const startTimeValidation = validateISODateTime(payload.startTime);
  if (!startTimeValidation.valid) {
    errors.push({field: "startTime", message: startTimeValidation.message});
  }

  // End time validation (optional - treat empty strings as undefined)
  if (payload.endTime !== undefined && payload.endTime !== null && payload.endTime !== "") {
    const endTimeValidation = validateISODateTime(payload.endTime);
    if (!endTimeValidation.valid) {
      errors.push({field: "endTime", message: endTimeValidation.message});
    }
  }

  // Price tiers validation
  const priceTiersValidation = validatePriceTiers(payload.priceTiers);
  if (!priceTiersValidation.valid) {
    errors.push({field: "priceTiers", message: priceTiersValidation.message});
  }

  // Address validation
  const addressLine1Validation = validateRequiredString(payload.addressLine1, "Address line 1");
  if (!addressLine1Validation.valid) {
    errors.push({field: "addressLine1", message: addressLine1Validation.message});
  }

  const cityValidation = validateRequiredString(payload.city, "City");
  if (!cityValidation.valid) {
    errors.push({field: "city", message: cityValidation.message});
  }

  const stateValidation = validateState(payload.state);
  if (!stateValidation.valid) {
    errors.push({field: "state", message: stateValidation.message});
  }

  const zipValidation = validateZip(payload.zip);
  if (!zipValidation.valid) {
    errors.push({field: "zip", message: zipValidation.message});
  }

  // Optional fields
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  if (payload.addressLine2 !== undefined && payload.addressLine2 !== null) {
    if (typeof payload.addressLine2 !== "string") {
      errors.push({field: "addressLine2", message: "Address line 2 must be a string"});
    }
  }

  if (payload.locationName !== undefined && payload.locationName !== null) {
    if (typeof payload.locationName !== "string") {
      errors.push({field: "locationName", message: "Location name must be a string"});
    }
  }

  // Image file validation (optional, base64 string)
  if (payload.imageFile !== undefined && payload.imageFile !== null) {
    if (typeof payload.imageFile !== "string") {
      errors.push({field: "imageFile", message: "Image file must be a base64 string"});
    } else if (!payload.imageFile.startsWith("data:image/")) {
      errors.push({field: "imageFile", message: "Image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update event payload
 * @param {Object} payload - Event update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateEventPayload(payload) {
  const errors = [];

  // Name validation (optional for update)
  if (payload.name !== undefined) {
    const nameValidation = validateRequiredString(payload.name, "Name");
    if (!nameValidation.valid) {
      errors.push({field: "name", message: nameValidation.message});
    }
  }

  // Type validation (optional for update)
  if (payload.type !== undefined) {
    const typeValidation = validateEventType(payload.type);
    if (!typeValidation.valid) {
      errors.push({field: "type", message: typeValidation.message});
    }
  }

  // Start time validation (optional for update)
  if (payload.startTime !== undefined) {
    const startTimeValidation = validateISODateTime(payload.startTime);
    if (!startTimeValidation.valid) {
      errors.push({field: "startTime", message: startTimeValidation.message});
    }
  }

  // End time validation (optional for update - treat empty strings as undefined)
  if (payload.endTime !== undefined && payload.endTime !== null && payload.endTime !== "") {
    const endTimeValidation = validateISODateTime(payload.endTime);
    if (!endTimeValidation.valid) {
      errors.push({field: "endTime", message: endTimeValidation.message});
    }
  }

  // Price tiers validation (optional for update)
  if (payload.priceTiers !== undefined) {
    const priceTiersValidation = validatePriceTiers(payload.priceTiers);
    if (!priceTiersValidation.valid) {
      errors.push({field: "priceTiers", message: priceTiersValidation.message});
    }
  }

  // Address validation (optional for update)
  if (payload.addressLine1 !== undefined) {
    const addressLine1Validation = validateRequiredString(payload.addressLine1, "Address line 1");
    if (!addressLine1Validation.valid) {
      errors.push({field: "addressLine1", message: addressLine1Validation.message});
    }
  }

  if (payload.city !== undefined) {
    const cityValidation = validateRequiredString(payload.city, "City");
    if (!cityValidation.valid) {
      errors.push({field: "city", message: cityValidation.message});
    }
  }

  if (payload.state !== undefined) {
    const stateValidation = validateState(payload.state);
    if (!stateValidation.valid) {
      errors.push({field: "state", message: stateValidation.message});
    }
  }

  if (payload.zip !== undefined) {
    const zipValidation = validateZip(payload.zip);
    if (!zipValidation.valid) {
      errors.push({field: "zip", message: zipValidation.message});
    }
  }

  // Optional fields
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  if (payload.addressLine2 !== undefined && payload.addressLine2 !== null) {
    if (typeof payload.addressLine2 !== "string") {
      errors.push({field: "addressLine2", message: "Address line 2 must be a string"});
    }
  }

  if (payload.locationName !== undefined && payload.locationName !== null) {
    if (typeof payload.locationName !== "string") {
      errors.push({field: "locationName", message: "Location name must be a string"});
    }
  }

  // Image file validation (optional, base64 string)
  if (payload.imageFile !== undefined && payload.imageFile !== null) {
    if (typeof payload.imageFile !== "string") {
      errors.push({field: "imageFile", message: "Image file must be a base64 string"});
    } else if (!payload.imageFile.startsWith("data:image/")) {
      errors.push({field: "imageFile", message: "Image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate class IDs array
 * @param {Array} classIds - Class IDs to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateClassIds(classIds) {
  if (classIds === undefined || classIds === null) {
    return {valid: false, message: "Class IDs are required"};
  }

  if (!Array.isArray(classIds)) {
    return {valid: false, message: "Class IDs must be an array"};
  }

  // All items should be strings
  if (!classIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return {valid: false, message: "All class IDs must be non-empty strings"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate create package payload
 * @param {Object} payload - Package data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreatePackagePayload(payload) {
  const errors = [];

  // Name validation
  const nameValidation = validateRequiredString(payload.name, "Name");
  if (!nameValidation.valid) {
    errors.push({field: "name", message: nameValidation.message});
  }

  // Price validation
  const priceValidation = validateCost(payload.price);
  if (!priceValidation.valid) {
    errors.push({field: "price", message: priceValidation.message});
  }

  // Credits validation
  if (payload.credits === undefined || payload.credits === null) {
    errors.push({field: "credits", message: "Credits are required"});
  } else if (typeof payload.credits !== "number" || isNaN(payload.credits) || payload.credits < 1) {
    errors.push({field: "credits", message: "Credits must be a positive number"});
  }

  // Expiration days validation
  if (payload.expirationDays === undefined || payload.expirationDays === null) {
    errors.push({field: "expirationDays", message: "Expiration days are required"});
  } else if (typeof payload.expirationDays !== "number" || isNaN(payload.expirationDays) || payload.expirationDays < 1) {
    errors.push({field: "expirationDays", message: "Expiration days must be a positive number"});
  }

  // Class IDs validation
  const classIdsValidation = validateClassIds(payload.classIds);
  if (!classIdsValidation.valid) {
    errors.push({field: "classIds", message: classIdsValidation.message});
  }

  // Is active validation
  if (payload.isActive === undefined || payload.isActive === null) {
    errors.push({field: "isActive", message: "Is active is required"});
  } else if (typeof payload.isActive !== "boolean") {
    errors.push({field: "isActive", message: "Is active must be a boolean"});
  }

  // Description validation (optional)
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update package payload
 * @param {Object} payload - Package update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdatePackagePayload(payload) {
  const errors = [];

  // Name validation (optional for update)
  if (payload.name !== undefined) {
    const nameValidation = validateRequiredString(payload.name, "Name");
    if (!nameValidation.valid) {
      errors.push({field: "name", message: nameValidation.message});
    }
  }

  // Price validation (optional for update)
  if (payload.price !== undefined) {
    const priceValidation = validateCost(payload.price);
    if (!priceValidation.valid) {
      errors.push({field: "price", message: priceValidation.message});
    }
  }

  // Credits validation (optional for update)
  if (payload.credits !== undefined) {
    if (typeof payload.credits !== "number" || isNaN(payload.credits) || payload.credits < 1) {
      errors.push({field: "credits", message: "Credits must be a positive number"});
    }
  }

  // Expiration days validation (optional for update)
  if (payload.expirationDays !== undefined) {
    if (typeof payload.expirationDays !== "number" || isNaN(payload.expirationDays) || payload.expirationDays < 1) {
      errors.push({field: "expirationDays", message: "Expiration days must be a positive number"});
    }
  }

  // Class IDs validation (optional for update)
  if (payload.classIds !== undefined) {
    const classIdsValidation = validateClassIds(payload.classIds);
    if (!classIdsValidation.valid) {
      errors.push({field: "classIds", message: classIdsValidation.message});
    }
  }

  // Is active validation (optional for update)
  if (payload.isActive !== undefined) {
    if (typeof payload.isActive !== "boolean") {
      errors.push({field: "isActive", message: "Is active must be a boolean"});
    }
  }

  // Description validation (optional)
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate create student payload
 * @param {Object} payload - Student data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateStudentPayload(payload) {
  const errors = [];

  // First name validation
  const firstNameValidation = validateRequiredString(payload.firstName, "First name");
  if (!firstNameValidation.valid) {
    errors.push({field: "firstName", message: firstNameValidation.message});
  }

  // Last name validation
  const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
  if (!lastNameValidation.valid) {
    errors.push({field: "lastName", message: lastNameValidation.message});
  }

  // Email validation (optional)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Credits validation (optional, defaults to 0)
  if (payload.credits !== undefined && payload.credits !== null) {
    if (typeof payload.credits !== "number" || isNaN(payload.credits) || payload.credits < 0) {
      errors.push({field: "credits", message: "Credits must be a non-negative number"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update student payload
 * @param {Object} payload - Student data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateStudentPayload(payload) {
  const errors = [];

  // First name validation (optional for update)
  if (payload.firstName !== undefined) {
    const firstNameValidation = validateRequiredString(payload.firstName, "First name");
    if (!firstNameValidation.valid) {
      errors.push({field: "firstName", message: firstNameValidation.message});
    }
  }

  // Last name validation (optional for update)
  if (payload.lastName !== undefined) {
    const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
    if (!lastNameValidation.valid) {
      errors.push({field: "lastName", message: lastNameValidation.message});
    }
  }

  // Email validation (optional for update)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional for update)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Credits validation (optional for update)
  if (payload.credits !== undefined && payload.credits !== null) {
    if (typeof payload.credits !== "number" || isNaN(payload.credits) || payload.credits < 0) {
      errors.push({field: "credits", message: "Credits must be a non-negative number"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate dance genre
 * @param {string} genre - Dance genre to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateDanceGenre(genre) {
  if (genre === undefined || genre === null || genre === "") {
    return {valid: true, message: ""}; // Optional field
  }

  const validGenres = ["salsa", "bachata", "zouk", "kizomba"];
  if (!validGenres.includes(genre.toLowerCase())) {
    return {
      valid: false,
      message: `Dance genre must be one of: ${validGenres.join(", ")}`,
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate student registration payload
 * @param {Object} payload - Student registration data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateStudentRegistrationPayload(payload) {
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

  // Dance genre validation (optional)
  if (payload.danceGenre !== undefined && payload.danceGenre !== null && payload.danceGenre !== "") {
    const danceGenreValidation = validateDanceGenre(payload.danceGenre);
    if (!danceGenreValidation.valid) {
      errors.push({field: "danceGenre", message: danceGenreValidation.message});
    }
  }

  // Subscribe to newsletter validation (optional, boolean)
  if (payload.subscribeToNewsletter !== undefined && payload.subscribeToNewsletter !== null) {
    if (typeof payload.subscribeToNewsletter !== "boolean") {
      errors.push({field: "subscribeToNewsletter", message: "Subscribe to newsletter must be a boolean"});
    }
  }

  // Avatar file validation (optional, base64 string)
  if (payload.avatarFile !== undefined && payload.avatarFile !== null) {
    if (typeof payload.avatarFile !== "string") {
      errors.push({field: "avatarFile", message: "Avatar file must be a base64 string"});
    } else if (!payload.avatarFile.startsWith("data:image/")) {
      errors.push({field: "avatarFile", message: "Avatar file must be a valid base64 image data URL"});
    }
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
  validateTimeFormat,
  validateClassLevel,
  validateDayOfWeek,
  validateCost,
  validateInstructorIds,
  validateCreateClassPayload,
  validateUpdateClassPayload,
  validatePhone,
  validateCreateInstructorPayload,
  validateUpdateInstructorPayload,
  validateUpdateProfilePayload,
  validateCreateWorkshopPayload,
  validateUpdateWorkshopPayload,
  validateCreateEventPayload,
  validateUpdateEventPayload,
  validateCreatePackagePayload,
  validateUpdatePackagePayload,
  validateCreateStudentPayload,
  validateUpdateStudentPayload,
  validateStudentRegistrationPayload,
  validateCreateBookingPayload,
};

/**
 * Validate date format (YYYY-MM-DD)
 * @param {string} date - Date string to validate
 * @returns {boolean}
 */
function isValidDateFormat(date) {
  if (!date || typeof date !== "string") {
    return false;
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return false;
  }
  const parsedDate = new Date(date + "T00:00:00");
  return !isNaN(parsedDate.getTime()) && parsedDate.toISOString().startsWith(date);
}

/**
 * Check if a date is in the past
 * @param {string} date - Date string (YYYY-MM-DD)
 * @returns {boolean}
 */
function isDateInPast(date) {
  if (!isValidDateFormat(date)) {
    return false;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkDate = new Date(date + "T00:00:00");
  return checkDate < today;
}

/**
 * Validate create booking payload
 * @param {Object} payload - Booking data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateBookingPayload(payload) {
  const errors = [];

  // Required fields validation
  if (!payload.instructorId || typeof payload.instructorId !== "string") {
    errors.push({field: "instructorId", message: "Instructor ID is required"});
  }

  if (!payload.studioId || typeof payload.studioId !== "string") {
    errors.push({field: "studioId", message: "Studio ID is required"});
  }

  // Date validation
  if (!payload.date || typeof payload.date !== "string") {
    errors.push({field: "date", message: "Date is required"});
  } else {
    if (!isValidDateFormat(payload.date)) {
      errors.push({field: "date", message: "Date must be in YYYY-MM-DD format"});
    } else if (isDateInPast(payload.date)) {
      errors.push({field: "date", message: "Cannot book dates in the past"});
    }
  }

  // Time slot validation
  if (!payload.timeSlot || typeof payload.timeSlot !== "object") {
    errors.push({field: "timeSlot", message: "Time slot is required"});
  } else {
    if (!payload.timeSlot.startTime || typeof payload.timeSlot.startTime !== "string") {
      errors.push({field: "timeSlot.startTime", message: "Start time is required"});
    } else if (!isValidTimeFormat(payload.timeSlot.startTime)) {
      errors.push({field: "timeSlot.startTime", message: "Start time must be in HH:mm format"});
    }

    if (!payload.timeSlot.endTime || typeof payload.timeSlot.endTime !== "string") {
      errors.push({field: "timeSlot.endTime", message: "End time is required"});
    } else if (!isValidTimeFormat(payload.timeSlot.endTime)) {
      errors.push({field: "timeSlot.endTime", message: "End time must be in HH:mm format"});
    }

    // Validate end time is after start time
    if (
      payload.timeSlot.startTime &&
      payload.timeSlot.endTime &&
      isValidTimeFormat(payload.timeSlot.startTime) &&
      isValidTimeFormat(payload.timeSlot.endTime)
    ) {
      const [startHours, startMinutes] = payload.timeSlot.startTime.split(":").map(Number);
      const [endHours, endMinutes] = payload.timeSlot.endTime.split(":").map(Number);
      const startTotal = startHours * 60 + startMinutes;
      const endTotal = endHours * 60 + endMinutes;

      if (endTotal <= startTotal) {
        errors.push({field: "timeSlot.endTime", message: "End time must be after start time"});
      }
    }
  }

  // Optional fields validation
  if (payload.notes !== undefined && payload.notes !== null) {
    if (typeof payload.notes !== "string") {
      errors.push({field: "notes", message: "Notes must be a string"});
    } else if (payload.notes.length > 1000) {
      errors.push({field: "notes", message: "Notes must be 1000 characters or less"});
    }
  }

  if (payload.contactInfo !== undefined && payload.contactInfo !== null) {
    if (typeof payload.contactInfo !== "object") {
      errors.push({field: "contactInfo", message: "Contact info must be an object"});
    } else {
      if (payload.contactInfo.email !== undefined && payload.contactInfo.email !== null) {
        if (typeof payload.contactInfo.email !== "string") {
          errors.push({field: "contactInfo.email", message: "Email must be a string"});
        } else if (!isValidEmail(payload.contactInfo.email)) {
          errors.push({field: "contactInfo.email", message: "Invalid email format"});
        }
      }

      if (payload.contactInfo.phone !== undefined && payload.contactInfo.phone !== null) {
        const phoneValidation = validatePhone(payload.contactInfo.phone);
        if (!phoneValidation.valid) {
          errors.push({field: "contactInfo.phone", message: phoneValidation.message});
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}


