import type { ValidationResult, ValidationErrors } from "../types/api";

type ValidationErrorList = Array<{ field: string; message: string }>;

// ─── Primitives ───────────────────────────────────────────────────────────────

export function isValidEmail(email: unknown): boolean {
  if (!email || typeof email !== "string") return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim().toLowerCase());
}

export function validatePassword(password: unknown): ValidationResult {
  if (!password || typeof password !== "string") {
    return { valid: false, message: "Password is required" };
  }
  if (password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters long" };
  }
  return { valid: true, message: "" };
}

export function validateRequiredString(value: unknown, fieldName: string): ValidationResult {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, message: `${fieldName} is required` };
  }
  return { valid: true, message: "" };
}

export function validateState(state: unknown): ValidationResult {
  if (!state || typeof state !== "string") {
    return { valid: false, message: "State is required" };
  }
  const stateRegex = /^[A-Za-z]{2}$/;
  if (!stateRegex.test(state.trim())) {
    return { valid: false, message: "State must be a 2-letter code" };
  }
  return { valid: true, message: "" };
}

export function validateZip(zip: unknown): ValidationResult {
  if (!zip || typeof zip !== "string") {
    return { valid: false, message: "ZIP code is required" };
  }
  const zipRegex = /^[0-9]{5}(?:[-\s][0-9]{4})?$/;
  if (!zipRegex.test(zip.trim())) {
    return { valid: false, message: "ZIP code must be 5 digits or 5+4 format" };
  }
  return { valid: true, message: "" };
}

export function validateUrl(url: unknown): ValidationResult {
  if (!url || (typeof url === "string" && url.trim().length === 0)) {
    return { valid: true, message: "" }; // Optional field
  }
  try {
    new URL(url as string);
    return { valid: true, message: "" };
  } catch (_) {
    return { valid: false, message: "Invalid URL format" };
  }
}

export function validateMembership(membership: unknown): ValidationResult {
  if (!membership || membership === null || membership === undefined) {
    return { valid: true, message: "" };
  }
  const validMemberships = ["individual_instructor", "studio_owner", "event_organizer", "ultimate"];
  if (!validMemberships.includes(membership as string)) {
    return {
      valid: false,
      message: `Membership must be one of: ${validMemberships.join(", ")}`,
    };
  }
  return { valid: true, message: "" };
}

export function validateTimeFormat(time: unknown): ValidationResult {
  if (!time || typeof time !== "string") {
    return { valid: false, message: "Time is required" };
  }
  const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(time.trim())) {
    return { valid: false, message: "Time must be in HH:mm format (24-hour)" };
  }
  return { valid: true, message: "" };
}

export function validateClassLevel(level: unknown): ValidationResult {
  const validLevels = ["Beginner", "Intermediate", "Advanced", "All Levels"];
  if (!level || !validLevels.includes(level as string)) {
    return { valid: false, message: `Level must be one of: ${validLevels.join(", ")}` };
  }
  return { valid: true, message: "" };
}

export function validateDayOfWeek(dayOfWeek: unknown): ValidationResult {
  const validDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (!dayOfWeek || !validDays.includes(dayOfWeek as string)) {
    return { valid: false, message: `Day of week must be one of: ${validDays.join(", ")}` };
  }
  return { valid: true, message: "" };
}

export function validateCost(cost: unknown): ValidationResult {
  if (cost === undefined || cost === null) {
    return { valid: false, message: "Cost is required" };
  }
  if (typeof cost !== "number" || isNaN(cost)) {
    return { valid: false, message: "Cost must be a number" };
  }
  if (cost < 0) {
    return { valid: false, message: "Cost must be greater than or equal to 0" };
  }
  return { valid: true, message: "" };
}

export function validateInstructorIds(instructorIds: unknown): ValidationResult {
  if (instructorIds === undefined || instructorIds === null) {
    return { valid: false, message: "Instructor IDs are required" };
  }
  if (!Array.isArray(instructorIds)) {
    return { valid: false, message: "Instructor IDs must be an array" };
  }
  if (!instructorIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return { valid: false, message: "All instructor IDs must be non-empty strings" };
  }
  return { valid: true, message: "" };
}

export function validatePhone(phone: unknown): ValidationResult {
  if (!phone || (typeof phone === "string" && phone.trim().length === 0)) {
    return { valid: true, message: "" }; // Optional field
  }
  const phoneRegex = /^[\d\s\-\(\)\+\.]+$/;
  if (!phoneRegex.test((phone as string).trim())) {
    return { valid: false, message: "Invalid phone number format" };
  }
  const digitsOnly = (phone as string).replace(/\D/g, "");
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return { valid: false, message: "Phone number must be between 10 and 15 digits" };
  }
  return { valid: true, message: "" };
}

export function validateDanceGenre(genre: unknown): ValidationResult {
  if (genre === undefined || genre === null || genre === "") {
    return { valid: true, message: "" }; // Optional field
  }
  const validGenres = [
    "salsa", "bachata", "merengue", "cumbia", "cha-cha", "reggaeton",
    "zouk", "kizomba", "semba", "afrobeats", "samba",
    "waltz", "tango", "argentine tango", "foxtrot", "quickstep", "viennese waltz",
    "west coast swing", "lindy hop", "east coast swing",
    "hip-hop", "breakdance", "house", "waacking", "voguing", "popping & locking",
    "contemporary", "jazz", "modern", "lyrical",
    "ballet", "tap", "flamenco", "belly dance",
  ];
  if (!validGenres.includes((genre as string).toLowerCase())) {
    return { valid: false, message: `Dance genre must be one of: ${validGenres.join(", ")}` };
  }
  return { valid: true, message: "" };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isValidTimeFormat(time: unknown): boolean {
  if (typeof time !== "string") return false;
  const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
}

function isValidDateFormat(date: unknown): boolean {
  if (!date || typeof date !== "string") return false;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return false;
  const parsedDate = new Date(date + "T00:00:00");
  return !isNaN(parsedDate.getTime()) && parsedDate.toISOString().startsWith(date);
}

function isDateInPast(date: string): boolean {
  if (!isValidDateFormat(date)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkDate = new Date(date + "T00:00:00");
  return checkDate < today;
}

function validateWorkshopLevel(level: unknown): ValidationResult {
  const validLevels = ["beginner", "intermediate", "advanced"];
  if (!level || !validLevels.includes((level as string).toLowerCase())) {
    return { valid: false, message: `Level must be one of: ${validLevels.join(", ")}` };
  }
  return { valid: true, message: "" };
}

function validateWorkshopLevels(levels: unknown): ValidationResult {
  if (levels === undefined || levels === null) {
    return { valid: false, message: "Levels are required" };
  }
  if (!Array.isArray(levels) || levels.length === 0) {
    return { valid: false, message: "Levels must be a non-empty array" };
  }
  for (const level of levels) {
    const v = validateWorkshopLevel(level);
    if (!v.valid) return { valid: false, message: v.message ?? "" };
  }
  return { valid: true, message: "" };
}

function validateISODateTime(dateTime: unknown): ValidationResult {
  if (!dateTime || typeof dateTime !== "string") {
    return { valid: false, message: "DateTime is required" };
  }
  const date = new Date(dateTime);
  if (isNaN(date.getTime())) {
    return { valid: false, message: "DateTime must be a valid ISO datetime string" };
  }
  return { valid: true, message: "" };
}

function validateEventType(type: unknown): ValidationResult {
  const validTypes = ["social", "festival", "congress"];
  if (!type || !validTypes.includes((type as string).toLowerCase())) {
    return { valid: false, message: `Event type must be one of: ${validTypes.join(", ")}` };
  }
  return { valid: true, message: "" };
}

interface PriceTier {
  name?: unknown;
  price?: unknown;
}

function validatePriceTier(tier: unknown): ValidationResult {
  if (!tier || typeof tier !== "object") {
    return { valid: false, message: "Price tier must be an object" };
  }
  const t = tier as PriceTier;
  if (!t.name || typeof t.name !== "string" || (t.name as string).trim().length === 0) {
    return { valid: false, message: "Price tier name is required" };
  }
  if (t.price === undefined || t.price === null || typeof t.price !== "number" || (t.price as number) < 0) {
    return { valid: false, message: "Price tier price must be a non-negative number" };
  }
  return { valid: true, message: "" };
}

function validatePriceTiers(priceTiers: unknown): ValidationResult {
  if (priceTiers === undefined || priceTiers === null) {
    return { valid: false, message: "Price tiers are required" };
  }
  if (!Array.isArray(priceTiers) || priceTiers.length === 0) {
    return { valid: false, message: "Price tiers must be a non-empty array" };
  }
  for (let i = 0; i < priceTiers.length; i++) {
    const v = validatePriceTier(priceTiers[i]);
    if (!v.valid) return { valid: false, message: `Price tier ${i + 1}: ${v.message}` };
  }
  return { valid: true, message: "" };
}

function validateClassIds(classIds: unknown): ValidationResult {
  if (classIds === undefined || classIds === null) {
    return { valid: false, message: "Class IDs are required" };
  }
  if (!Array.isArray(classIds)) {
    return { valid: false, message: "Class IDs must be an array" };
  }
  if (!classIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return { valid: false, message: "All class IDs must be non-empty strings" };
  }
  return { valid: true, message: "" };
}

interface TimeSlotLike {
  startTime?: unknown;
  endTime?: unknown;
}

function validateTimeSlot(timeSlot: unknown): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (!timeSlot || typeof timeSlot !== "object") {
    errors.push({ field: "timeSlot", message: "Time slot must be an object" });
    return { valid: false, errors };
  }
  const slot = timeSlot as TimeSlotLike;
  if (!slot.startTime || typeof slot.startTime !== "string") {
    errors.push({ field: "startTime", message: "Start time is required and must be a string" });
  } else if (!isValidTimeFormat(slot.startTime)) {
    errors.push({ field: "startTime", message: "Start time must be in HH:mm format" });
  }
  if (!slot.endTime || typeof slot.endTime !== "string") {
    errors.push({ field: "endTime", message: "End time is required and must be a string" });
  } else if (!isValidTimeFormat(slot.endTime)) {
    errors.push({ field: "endTime", message: "End time must be in HH:mm format" });
  }
  if (
    slot.startTime && slot.endTime &&
    isValidTimeFormat(slot.startTime) && isValidTimeFormat(slot.endTime)
  ) {
    const [sh, sm] = (slot.startTime as string).split(":").map(Number);
    const [eh, em] = (slot.endTime as string).split(":").map(Number);
    const startTotal = (sh ?? 0) * 60 + (sm ?? 0);
    const endTotal = (eh ?? 0) * 60 + (em ?? 0);
    if (endTotal <= startTotal) {
      errors.push({ field: "endTime", message: "End time must be after start time" });
    }
    const duration = endTotal - startTotal;
    if (duration !== 60) {
      errors.push({ field: "duration", message: "Time slot must be exactly 1 hour" });
    }
  }
  return { valid: errors.length === 0, errors };
}

interface DayAvailLike {
  day?: unknown;
  available?: unknown;
  timeSlots?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

function validateDayAvailability(dayAvail: DayAvailLike): ValidationErrors {
  const errors: ValidationErrorList = [];
  const validDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  if (!dayAvail.day || typeof dayAvail.day !== "string") {
    errors.push({ field: "day", message: "Day is required and must be a string" });
  } else if (!validDays.includes((dayAvail.day as string).toLowerCase())) {
    errors.push({ field: "day", message: `Day must be one of: ${validDays.join(", ")}` });
  }
  if (dayAvail.available !== undefined && typeof dayAvail.available !== "boolean") {
    errors.push({ field: "available", message: "Available must be a boolean" });
  }
  if (dayAvail.available === true) {
    if (dayAvail.timeSlots !== undefined && dayAvail.timeSlots !== null) {
      if (!Array.isArray(dayAvail.timeSlots)) {
        errors.push({ field: "timeSlots", message: "Time slots must be an array" });
      } else {
        const slots = dayAvail.timeSlots as unknown[];
        slots.forEach((slot, index) => {
          const sv = validateTimeSlot(slot);
          if (!sv.valid) {
            sv.errors.forEach((err) => {
              errors.push({ field: `timeSlots[${index}].${err.field}`, message: err.message });
            });
          }
        });
        const sortedSlots = [...slots].sort((a, b) => {
          const as_ = a as TimeSlotLike;
          const bs_ = b as TimeSlotLike;
          const [ah, am] = (as_.startTime as string).split(":").map(Number);
          const [bh, bm] = (bs_.startTime as string).split(":").map(Number);
          return ((ah ?? 0) * 60 + (am ?? 0)) - ((bh ?? 0) * 60 + (bm ?? 0));
        });
        for (let i = 0; i < sortedSlots.length - 1; i++) {
          const cur = sortedSlots[i] as TimeSlotLike;
          const nxt = sortedSlots[i + 1] as TimeSlotLike;
          const [ceh, cem] = (cur.endTime as string).split(":").map(Number);
          const [nsh, nsm] = (nxt.startTime as string).split(":").map(Number);
          const currentEndTotal = (ceh ?? 0) * 60 + (cem ?? 0);
          const nextStartTotal = (nsh ?? 0) * 60 + (nsm ?? 0);
          if (nextStartTotal < currentEndTotal) {
            errors.push({ field: "timeSlots", message: "Time slots cannot overlap" });
            break;
          }
        }
      }
    } else if (dayAvail.startTime !== undefined || dayAvail.endTime !== undefined) {
      if (dayAvail.startTime !== undefined && dayAvail.startTime !== null) {
        if (!isValidTimeFormat(dayAvail.startTime)) {
          errors.push({ field: "startTime", message: "Start time must be in HH:mm format" });
        }
      }
      if (dayAvail.endTime !== undefined && dayAvail.endTime !== null) {
        if (!isValidTimeFormat(dayAvail.endTime)) {
          errors.push({ field: "endTime", message: "End time must be in HH:mm format" });
        }
      }
      if (
        dayAvail.startTime && dayAvail.endTime &&
        isValidTimeFormat(dayAvail.startTime) && isValidTimeFormat(dayAvail.endTime)
      ) {
        const [sh, sm] = (dayAvail.startTime as string).split(":").map(Number);
        const [eh, em] = (dayAvail.endTime as string).split(":").map(Number);
        const startTotal = (sh ?? 0) * 60 + (sm ?? 0);
        const endTotal = (eh ?? 0) * 60 + (em ?? 0);
        if (endTotal <= startTotal) {
          errors.push({ field: "endTime", message: "End time must be after start time" });
        }
      }
    } else {
      errors.push({ field: "timeSlots", message: "Time slots or start/end time required when available is true" });
    }
  }
  return { valid: errors.length === 0, errors };
}

interface AvailabilityPayloadLike {
  availableForPrivates?: unknown;
  availability?: unknown;
}

function validateInstructorAvailability(availability: AvailabilityPayloadLike): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (availability.availableForPrivates !== undefined && typeof availability.availableForPrivates !== "boolean") {
    errors.push({ field: "availableForPrivates", message: "availableForPrivates must be a boolean" });
  }
  if (availability.availability !== undefined && availability.availability !== null) {
    if (!Array.isArray(availability.availability)) {
      errors.push({ field: "availability", message: "Availability must be an array" });
    } else {
      (availability.availability as unknown[]).forEach((dayAvail, index) => {
        const dv = validateDayAvailability(dayAvail as DayAvailLike);
        if (!dv.valid) {
          dv.errors.forEach((err) => {
            errors.push({ field: `availability[${index}].${err.field}`, message: err.message });
          });
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── Registration / Login ─────────────────────────────────────────────────────

export function validateRegistrationPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (!isValidEmail(payload["email"])) {
    errors.push({ field: "email", message: "Valid email is required" });
  }
  const passwordV = validatePassword(payload["password"]);
  if (!passwordV.valid) errors.push({ field: "password", message: passwordV.message ?? "" });

  for (const field of ["firstName", "lastName", "studioName", "studioAddressLine1", "city"]) {
    const v = validateRequiredString(payload[field], field.charAt(0).toUpperCase() + field.slice(1));
    if (!v.valid) errors.push({ field, message: v.message ?? "" });
  }

  const stateV = validateState(payload["state"]);
  if (!stateV.valid) errors.push({ field: "state", message: stateV.message ?? "" });

  const zipV = validateZip(payload["zip"]);
  if (!zipV.valid) errors.push({ field: "zip", message: zipV.message ?? "" });

  if (payload["membership"] !== undefined && payload["membership"] !== null) {
    const mv = validateMembership(payload["membership"]);
    if (!mv.valid) errors.push({ field: "membership", message: mv.message ?? "" });
  }

  for (const field of ["facebook", "instagram", "tiktok", "youtube"]) {
    if (payload[field]) {
      const uv = validateUrl(payload[field]);
      if (!uv.valid) errors.push({ field, message: uv.message ?? "" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateLoginPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (!isValidEmail(payload["email"])) {
    errors.push({ field: "email", message: "Valid email is required" });
  }
  if (!payload["password"] || (payload["password"] as string).trim().length === 0) {
    errors.push({ field: "password", message: "Password is required" });
  }
  return { valid: errors.length === 0, errors };
}

// ─── Class ────────────────────────────────────────────────────────────────────

export function validateCreateClassPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const nameV = validateRequiredString(payload["name"], "Name");
  if (!nameV.valid) errors.push({ field: "name", message: nameV.message ?? "" });

  const levelV = validateClassLevel(payload["level"]);
  if (!levelV.valid) errors.push({ field: "level", message: levelV.message ?? "" });

  const costV = validateCost(payload["cost"]);
  if (!costV.valid) errors.push({ field: "cost", message: costV.message ?? "" });

  const dayV = validateDayOfWeek(payload["dayOfWeek"]);
  if (!dayV.valid) errors.push({ field: "dayOfWeek", message: dayV.message ?? "" });

  const startV = validateTimeFormat(payload["startTime"]);
  if (!startV.valid) errors.push({ field: "startTime", message: startV.message ?? "" });

  const endV = validateTimeFormat(payload["endTime"]);
  if (!endV.valid) errors.push({ field: "endTime", message: endV.message ?? "" });

  const idsV = validateInstructorIds(payload["instructorIds"]);
  if (!idsV.valid) errors.push({ field: "instructorIds", message: idsV.message ?? "" });

  if (payload["isActive"] === undefined || payload["isActive"] === null) {
    errors.push({ field: "isActive", message: "IsActive is required" });
  } else if (typeof payload["isActive"] !== "boolean") {
    errors.push({ field: "isActive", message: "IsActive must be a boolean" });
  }

  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }

  if (payload["room"] !== undefined && payload["room"] !== null) {
    if (typeof payload["room"] !== "string") {
      errors.push({ field: "room", message: "Room must be a string" });
    }
  }

  const genreV = validateDanceGenre(payload["danceGenre"]);
  if (!genreV.valid) errors.push({ field: "danceGenre", message: genreV.message ?? "" });

  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateClassPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["name"] !== undefined) {
    const v = validateRequiredString(payload["name"], "Name");
    if (!v.valid) errors.push({ field: "name", message: v.message ?? "" });
  }
  if (payload["level"] !== undefined) {
    const v = validateClassLevel(payload["level"]);
    if (!v.valid) errors.push({ field: "level", message: v.message ?? "" });
  }
  if (payload["cost"] !== undefined) {
    const v = validateCost(payload["cost"]);
    if (!v.valid) errors.push({ field: "cost", message: v.message ?? "" });
  }
  if (payload["dayOfWeek"] !== undefined) {
    const v = validateDayOfWeek(payload["dayOfWeek"]);
    if (!v.valid) errors.push({ field: "dayOfWeek", message: v.message ?? "" });
  }
  if (payload["startTime"] !== undefined) {
    const v = validateTimeFormat(payload["startTime"]);
    if (!v.valid) errors.push({ field: "startTime", message: v.message ?? "" });
  }
  if (payload["endTime"] !== undefined) {
    const v = validateTimeFormat(payload["endTime"]);
    if (!v.valid) errors.push({ field: "endTime", message: v.message ?? "" });
  }
  if (payload["instructorIds"] !== undefined) {
    const v = validateInstructorIds(payload["instructorIds"]);
    if (!v.valid) errors.push({ field: "instructorIds", message: v.message ?? "" });
  }
  if (payload["isActive"] !== undefined && payload["isActive"] !== null) {
    if (typeof payload["isActive"] !== "boolean") {
      errors.push({ field: "isActive", message: "IsActive must be a boolean" });
    }
  }
  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }
  if (payload["room"] !== undefined && payload["room"] !== null) {
    if (typeof payload["room"] !== "string") {
      errors.push({ field: "room", message: "Room must be a string" });
    }
  }
  if (payload["danceGenre"] !== undefined && payload["danceGenre"] !== null && payload["danceGenre"] !== "") {
    const v = validateDanceGenre(payload["danceGenre"]);
    if (!v.valid) errors.push({ field: "danceGenre", message: v.message ?? "" });
  }
  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Instructor ───────────────────────────────────────────────────────────────

export function validateCreateInstructorPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const fnV = validateRequiredString(payload["firstName"], "First name");
  if (!fnV.valid) errors.push({ field: "firstName", message: fnV.message ?? "" });

  const lnV = validateRequiredString(payload["lastName"], "Last name");
  if (!lnV.valid) errors.push({ field: "lastName", message: lnV.message ?? "" });

  if (payload["email"] !== undefined && payload["email"] !== null && (payload["email"] as string).trim() !== "") {
    if (!isValidEmail(payload["email"])) {
      errors.push({ field: "email", message: "Invalid email format" });
    }
  }
  if (payload["phone"] !== undefined && payload["phone"] !== null && (payload["phone"] as string).trim() !== "") {
    const pv = validatePhone(payload["phone"]);
    if (!pv.valid) errors.push({ field: "phone", message: pv.message ?? "" });
  }
  if (payload["bio"] !== undefined && payload["bio"] !== null) {
    if (typeof payload["bio"] !== "string") {
      errors.push({ field: "bio", message: "Bio must be a string" });
    }
  }
  if (payload["photoUrl"] !== undefined && payload["photoUrl"] !== null) {
    if (typeof payload["photoUrl"] !== "string") {
      errors.push({ field: "photoUrl", message: "Photo URL must be a string" });
    }
  }
  if (payload["availability"] !== undefined && payload["availability"] !== null) {
    const av = validateInstructorAvailability(payload["availability"] as AvailabilityPayloadLike);
    if (!av.valid) {
      errors.push(...av.errors.map((err) => ({ field: `availability.${err.field}`, message: err.message })));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateInstructorPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["firstName"] !== undefined) {
    const v = validateRequiredString(payload["firstName"], "First name");
    if (!v.valid) errors.push({ field: "firstName", message: v.message ?? "" });
  }
  if (payload["lastName"] !== undefined) {
    const v = validateRequiredString(payload["lastName"], "Last name");
    if (!v.valid) errors.push({ field: "lastName", message: v.message ?? "" });
  }
  if (payload["email"] !== undefined && payload["email"] !== null && (payload["email"] as string).trim() !== "") {
    if (!isValidEmail(payload["email"])) errors.push({ field: "email", message: "Invalid email format" });
  }
  if (payload["phone"] !== undefined && payload["phone"] !== null && (payload["phone"] as string).trim() !== "") {
    const pv = validatePhone(payload["phone"]);
    if (!pv.valid) errors.push({ field: "phone", message: pv.message ?? "" });
  }
  if (payload["bio"] !== undefined && payload["bio"] !== null) {
    if (typeof payload["bio"] !== "string") errors.push({ field: "bio", message: "Bio must be a string" });
  }
  if (payload["photoUrl"] !== undefined && payload["photoUrl"] !== null) {
    if (typeof payload["photoUrl"] !== "string") errors.push({ field: "photoUrl", message: "Photo URL must be a string" });
  }
  if (payload["availability"] !== undefined && payload["availability"] !== null) {
    const av = validateInstructorAvailability(payload["availability"] as AvailabilityPayloadLike);
    if (!av.valid) {
      errors.push(...av.errors.map((err) => ({ field: `availability.${err.field}`, message: err.message })));
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export function validateUpdateProfilePayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const strOptional = (key: string, label: string) => {
    if (payload[key] !== undefined) {
      const v = validateRequiredString(payload[key], label);
      if (!v.valid) errors.push({ field: key, message: v.message ?? "" });
    }
  };

  strOptional("firstName", "First name");
  strOptional("lastName", "Last name");
  strOptional("studioName", "Studio name");
  strOptional("studioAddressLine1", "Studio address line 1");
  strOptional("city", "City");

  if (payload["studioAddressLine2"] !== undefined && payload["studioAddressLine2"] !== null) {
    if (typeof payload["studioAddressLine2"] !== "string") {
      errors.push({ field: "studioAddressLine2", message: "Studio address line 2 must be a string" });
    }
  }

  if (payload["state"] !== undefined) {
    const v = validateState(payload["state"]);
    if (!v.valid) errors.push({ field: "state", message: v.message ?? "" });
  }
  if (payload["zip"] !== undefined) {
    const v = validateZip(payload["zip"]);
    if (!v.valid) errors.push({ field: "zip", message: v.message ?? "" });
  }

  for (const field of ["facebook", "instagram", "tiktok", "youtube"]) {
    if (payload[field] !== undefined && payload[field] !== null && (payload[field] as string).trim() !== "") {
      const uv = validateUrl(payload[field]);
      if (!uv.valid) errors.push({ field, message: uv.message ?? "" });
    }
  }

  if (payload["studioImageFile"] !== undefined && payload["studioImageFile"] !== null) {
    if (typeof payload["studioImageFile"] !== "string") {
      errors.push({ field: "studioImageFile", message: "Studio image file must be a base64 string" });
    } else if (!payload["studioImageFile"].startsWith("data:image/")) {
      errors.push({ field: "studioImageFile", message: "Studio image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Workshop ─────────────────────────────────────────────────────────────────

export function validateCreateWorkshopPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const nameV = validateRequiredString(payload["name"], "Name");
  if (!nameV.valid) errors.push({ field: "name", message: nameV.message ?? "" });

  const levelsV = validateWorkshopLevels(payload["levels"]);
  if (!levelsV.valid) errors.push({ field: "levels", message: levelsV.message ?? "" });

  const startV = validateISODateTime(payload["startTime"]);
  if (!startV.valid) errors.push({ field: "startTime", message: startV.message ?? "" });

  const endV = validateISODateTime(payload["endTime"]);
  if (!endV.valid) errors.push({ field: "endTime", message: endV.message ?? "" });

  const priceV = validatePriceTiers(payload["priceTiers"]);
  if (!priceV.valid) errors.push({ field: "priceTiers", message: priceV.message ?? "" });

  const addr1V = validateRequiredString(payload["addressLine1"], "Address line 1");
  if (!addr1V.valid) errors.push({ field: "addressLine1", message: addr1V.message ?? "" });

  const cityV = validateRequiredString(payload["city"], "City");
  if (!cityV.valid) errors.push({ field: "city", message: cityV.message ?? "" });

  const stateV = validateState(payload["state"]);
  if (!stateV.valid) errors.push({ field: "state", message: stateV.message ?? "" });

  const zipV = validateZip(payload["zip"]);
  if (!zipV.valid) errors.push({ field: "zip", message: zipV.message ?? "" });

  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }
  if (payload["addressLine2"] !== undefined && payload["addressLine2"] !== null) {
    if (typeof payload["addressLine2"] !== "string") {
      errors.push({ field: "addressLine2", message: "Address line 2 must be a string" });
    }
  }
  if (payload["locationName"] !== undefined && payload["locationName"] !== null) {
    if (typeof payload["locationName"] !== "string") {
      errors.push({ field: "locationName", message: "Location name must be a string" });
    }
  }

  const genreV = validateDanceGenre(payload["danceGenre"]);
  if (!genreV.valid) errors.push({ field: "danceGenre", message: genreV.message ?? "" });

  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateWorkshopPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["name"] !== undefined) {
    const v = validateRequiredString(payload["name"], "Name");
    if (!v.valid) errors.push({ field: "name", message: v.message ?? "" });
  }
  if (payload["levels"] !== undefined) {
    const v = validateWorkshopLevels(payload["levels"]);
    if (!v.valid) errors.push({ field: "levels", message: v.message ?? "" });
  }
  if (payload["startTime"] !== undefined) {
    const v = validateISODateTime(payload["startTime"]);
    if (!v.valid) errors.push({ field: "startTime", message: v.message ?? "" });
  }
  if (payload["endTime"] !== undefined) {
    const v = validateISODateTime(payload["endTime"]);
    if (!v.valid) errors.push({ field: "endTime", message: v.message ?? "" });
  }
  if (payload["priceTiers"] !== undefined) {
    const v = validatePriceTiers(payload["priceTiers"]);
    if (!v.valid) errors.push({ field: "priceTiers", message: v.message ?? "" });
  }
  if (payload["addressLine1"] !== undefined) {
    const v = validateRequiredString(payload["addressLine1"], "Address line 1");
    if (!v.valid) errors.push({ field: "addressLine1", message: v.message ?? "" });
  }
  if (payload["city"] !== undefined) {
    const v = validateRequiredString(payload["city"], "City");
    if (!v.valid) errors.push({ field: "city", message: v.message ?? "" });
  }
  if (payload["state"] !== undefined) {
    const v = validateState(payload["state"]);
    if (!v.valid) errors.push({ field: "state", message: v.message ?? "" });
  }
  if (payload["zip"] !== undefined) {
    const v = validateZip(payload["zip"]);
    if (!v.valid) errors.push({ field: "zip", message: v.message ?? "" });
  }
  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }
  if (payload["addressLine2"] !== undefined && payload["addressLine2"] !== null) {
    if (typeof payload["addressLine2"] !== "string") {
      errors.push({ field: "addressLine2", message: "Address line 2 must be a string" });
    }
  }
  if (payload["locationName"] !== undefined && payload["locationName"] !== null) {
    if (typeof payload["locationName"] !== "string") {
      errors.push({ field: "locationName", message: "Location name must be a string" });
    }
  }
  if (payload["danceGenre"] !== undefined && payload["danceGenre"] !== null && payload["danceGenre"] !== "") {
    const v = validateDanceGenre(payload["danceGenre"]);
    if (!v.valid) errors.push({ field: "danceGenre", message: v.message ?? "" });
  }
  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Event ────────────────────────────────────────────────────────────────────

export function validateCreateEventPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const nameV = validateRequiredString(payload["name"], "Name");
  if (!nameV.valid) errors.push({ field: "name", message: nameV.message ?? "" });

  const typeV = validateEventType(payload["type"]);
  if (!typeV.valid) errors.push({ field: "type", message: typeV.message ?? "" });

  const startV = validateISODateTime(payload["startTime"]);
  if (!startV.valid) errors.push({ field: "startTime", message: startV.message ?? "" });

  if (payload["endTime"] !== undefined && payload["endTime"] !== null && payload["endTime"] !== "") {
    const v = validateISODateTime(payload["endTime"]);
    if (!v.valid) errors.push({ field: "endTime", message: v.message ?? "" });
  }

  const priceV = validatePriceTiers(payload["priceTiers"]);
  if (!priceV.valid) errors.push({ field: "priceTiers", message: priceV.message ?? "" });

  const addr1V = validateRequiredString(payload["addressLine1"], "Address line 1");
  if (!addr1V.valid) errors.push({ field: "addressLine1", message: addr1V.message ?? "" });

  const cityV = validateRequiredString(payload["city"], "City");
  if (!cityV.valid) errors.push({ field: "city", message: cityV.message ?? "" });

  const stateV = validateState(payload["state"]);
  if (!stateV.valid) errors.push({ field: "state", message: stateV.message ?? "" });

  const zipV = validateZip(payload["zip"]);
  if (!zipV.valid) errors.push({ field: "zip", message: zipV.message ?? "" });

  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }
  if (payload["addressLine2"] !== undefined && payload["addressLine2"] !== null) {
    if (typeof payload["addressLine2"] !== "string") {
      errors.push({ field: "addressLine2", message: "Address line 2 must be a string" });
    }
  }
  if (payload["locationName"] !== undefined && payload["locationName"] !== null) {
    if (typeof payload["locationName"] !== "string") {
      errors.push({ field: "locationName", message: "Location name must be a string" });
    }
  }

  const genreV = validateDanceGenre(payload["danceGenre"]);
  if (!genreV.valid) errors.push({ field: "danceGenre", message: genreV.message ?? "" });

  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateEventPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["name"] !== undefined) {
    const v = validateRequiredString(payload["name"], "Name");
    if (!v.valid) errors.push({ field: "name", message: v.message ?? "" });
  }
  if (payload["type"] !== undefined) {
    const v = validateEventType(payload["type"]);
    if (!v.valid) errors.push({ field: "type", message: v.message ?? "" });
  }
  if (payload["startTime"] !== undefined) {
    const v = validateISODateTime(payload["startTime"]);
    if (!v.valid) errors.push({ field: "startTime", message: v.message ?? "" });
  }
  if (payload["endTime"] !== undefined && payload["endTime"] !== null && payload["endTime"] !== "") {
    const v = validateISODateTime(payload["endTime"]);
    if (!v.valid) errors.push({ field: "endTime", message: v.message ?? "" });
  }
  if (payload["priceTiers"] !== undefined) {
    const v = validatePriceTiers(payload["priceTiers"]);
    if (!v.valid) errors.push({ field: "priceTiers", message: v.message ?? "" });
  }
  if (payload["addressLine1"] !== undefined) {
    const v = validateRequiredString(payload["addressLine1"], "Address line 1");
    if (!v.valid) errors.push({ field: "addressLine1", message: v.message ?? "" });
  }
  if (payload["city"] !== undefined) {
    const v = validateRequiredString(payload["city"], "City");
    if (!v.valid) errors.push({ field: "city", message: v.message ?? "" });
  }
  if (payload["state"] !== undefined) {
    const v = validateState(payload["state"]);
    if (!v.valid) errors.push({ field: "state", message: v.message ?? "" });
  }
  if (payload["zip"] !== undefined) {
    const v = validateZip(payload["zip"]);
    if (!v.valid) errors.push({ field: "zip", message: v.message ?? "" });
  }
  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }
  if (payload["addressLine2"] !== undefined && payload["addressLine2"] !== null) {
    if (typeof payload["addressLine2"] !== "string") {
      errors.push({ field: "addressLine2", message: "Address line 2 must be a string" });
    }
  }
  if (payload["locationName"] !== undefined && payload["locationName"] !== null) {
    if (typeof payload["locationName"] !== "string") {
      errors.push({ field: "locationName", message: "Location name must be a string" });
    }
  }
  if (payload["danceGenre"] !== undefined && payload["danceGenre"] !== null && payload["danceGenre"] !== "") {
    const v = validateDanceGenre(payload["danceGenre"]);
    if (!v.valid) errors.push({ field: "danceGenre", message: v.message ?? "" });
  }
  if (payload["imageFile"] !== undefined && payload["imageFile"] !== null) {
    if (typeof payload["imageFile"] !== "string") {
      errors.push({ field: "imageFile", message: "Image file must be a base64 string" });
    } else if (!payload["imageFile"].startsWith("data:image/")) {
      errors.push({ field: "imageFile", message: "Image file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Package ──────────────────────────────────────────────────────────────────

function validateRecurringFields(payload: Record<string, unknown>, errors: ValidationErrorList): void {
  if (payload["billingFrequency"] === undefined || payload["billingFrequency"] === null) {
    errors.push({ field: "billingFrequency", message: "Billing frequency is required when recurring is enabled" });
  } else {
    const validFrequencies = ["monthly", "weekly", "daily"];
    const isNumber = typeof payload["billingFrequency"] === "number" && !isNaN(payload["billingFrequency"] as number);
    const isString = typeof payload["billingFrequency"] === "string" && validFrequencies.includes(payload["billingFrequency"] as string);
    if (!isNumber && !isString) {
      errors.push({ field: "billingFrequency", message: "Billing frequency must be 'monthly', 'weekly', 'daily', or a number (days)" });
    } else if (isNumber && (payload["billingFrequency"] as number) < 1) {
      errors.push({ field: "billingFrequency", message: "Billing frequency (days) must be at least 1" });
    }
  }
  if (payload["billingInterval"] === undefined || payload["billingInterval"] === null) {
    errors.push({ field: "billingInterval", message: "Billing interval is required when recurring is enabled" });
  } else if (typeof payload["billingInterval"] !== "number" || isNaN(payload["billingInterval"] as number) || (payload["billingInterval"] as number) < 1) {
    errors.push({ field: "billingInterval", message: "Billing interval must be a positive number" });
  }
  if (payload["subscriptionDuration"] !== undefined && payload["subscriptionDuration"] !== null) {
    if (typeof payload["subscriptionDuration"] !== "number" || isNaN(payload["subscriptionDuration"] as number) || (payload["subscriptionDuration"] as number) < 1) {
      errors.push({ field: "subscriptionDuration", message: "Subscription duration must be a positive number" });
    }
  }
}

export function validateCreatePackagePayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const nameV = validateRequiredString(payload["name"], "Name");
  if (!nameV.valid) errors.push({ field: "name", message: nameV.message ?? "" });

  const priceV = validateCost(payload["price"]);
  if (!priceV.valid) errors.push({ field: "price", message: priceV.message ?? "" });

  if (payload["credits"] === undefined || payload["credits"] === null) {
    errors.push({ field: "credits", message: "Credits are required" });
  } else if (typeof payload["credits"] !== "number" || isNaN(payload["credits"] as number) || (payload["credits"] as number) < 1) {
    errors.push({ field: "credits", message: "Credits must be a positive number" });
  }

  if (payload["expirationDays"] === undefined || payload["expirationDays"] === null) {
    errors.push({ field: "expirationDays", message: "Expiration days are required" });
  } else if (typeof payload["expirationDays"] !== "number" || isNaN(payload["expirationDays"] as number) || (payload["expirationDays"] as number) < 1) {
    errors.push({ field: "expirationDays", message: "Expiration days must be a positive number" });
  }

  const classIdsV = validateClassIds(payload["classIds"]);
  if (!classIdsV.valid) errors.push({ field: "classIds", message: classIdsV.message ?? "" });

  if (payload["isActive"] === undefined || payload["isActive"] === null) {
    errors.push({ field: "isActive", message: "Is active is required" });
  } else if (typeof payload["isActive"] !== "boolean") {
    errors.push({ field: "isActive", message: "Is active must be a boolean" });
  }

  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }

  if (payload["images"] !== undefined && payload["images"] !== null) {
    if (!Array.isArray(payload["images"])) {
      errors.push({ field: "images", message: "Images must be an array of URL strings" });
    } else if (!(payload["images"] as unknown[]).every((img) => typeof img === "string" && (img as string).trim().length > 0)) {
      errors.push({ field: "images", message: "Each image must be a non-empty string URL" });
    }
  }

  if (payload["url"] !== undefined && payload["url"] !== null) {
    if (typeof payload["url"] !== "string" || (payload["url"] as string).trim().length === 0) {
      errors.push({ field: "url", message: "URL must be a non-empty string" });
    }
  }

  if (payload["statement_descriptor"] !== undefined && payload["statement_descriptor"] !== null) {
    if (typeof payload["statement_descriptor"] !== "string") {
      errors.push({ field: "statement_descriptor", message: "Statement descriptor must be a string" });
    } else if ((payload["statement_descriptor"] as string).length > 22) {
      errors.push({ field: "statement_descriptor", message: "Statement descriptor must be 22 characters or fewer" });
    }
  }

  if (payload["tax_code"] !== undefined && payload["tax_code"] !== null) {
    if (typeof payload["tax_code"] !== "string" || (payload["tax_code"] as string).trim().length === 0) {
      errors.push({ field: "tax_code", message: "Tax code must be a non-empty string" });
    }
  }

  if (payload["unit_label"] !== undefined && payload["unit_label"] !== null) {
    if (typeof payload["unit_label"] !== "string" || (payload["unit_label"] as string).trim().length === 0) {
      errors.push({ field: "unit_label", message: "Unit label must be a non-empty string" });
    }
  }

  if (payload["shippable"] !== undefined && payload["shippable"] !== null) {
    if (typeof payload["shippable"] !== "boolean") {
      errors.push({ field: "shippable", message: "Shippable must be a boolean" });
    }
  }

  if (payload["package_dimensions"] !== undefined && payload["package_dimensions"] !== null) {
    const dims = payload["package_dimensions"] as Record<string, unknown>;
    if (typeof dims !== "object" || Array.isArray(dims)) {
      errors.push({ field: "package_dimensions", message: "Package dimensions must be an object" });
    } else {
      for (const key of ["height", "length", "weight", "width"]) {
        if (dims[key] === undefined || typeof dims[key] !== "number" || (dims[key] as number) <= 0) {
          errors.push({ field: `package_dimensions.${key}`, message: `Package dimensions ${key} must be a positive number` });
        }
      }
    }
  }

  if (payload["currency"] !== undefined && payload["currency"] !== null) {
    if (typeof payload["currency"] !== "string" || (payload["currency"] as string).trim().length !== 3) {
      errors.push({ field: "currency", message: "Currency must be a 3-letter ISO 4217 code (e.g. 'usd')" });
    }
  }

  if (payload["tax_behavior"] !== undefined && payload["tax_behavior"] !== null) {
    const validTaxBehaviors = ["exclusive", "inclusive", "unspecified"];
    if (!validTaxBehaviors.includes(payload["tax_behavior"] as string)) {
      errors.push({ field: "tax_behavior", message: "Tax behavior must be 'exclusive', 'inclusive', or 'unspecified'" });
    }
  }

  if (payload["isRecurring"] !== undefined && payload["isRecurring"] !== null) {
    if (typeof payload["isRecurring"] !== "boolean") {
      errors.push({ field: "isRecurring", message: "Is recurring must be a boolean" });
    } else if (payload["isRecurring"] === true) {
      validateRecurringFields(payload, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdatePackagePayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["name"] !== undefined) {
    const v = validateRequiredString(payload["name"], "Name");
    if (!v.valid) errors.push({ field: "name", message: v.message ?? "" });
  }
  if (payload["price"] !== undefined) {
    const v = validateCost(payload["price"]);
    if (!v.valid) errors.push({ field: "price", message: v.message ?? "" });
  }
  if (payload["credits"] !== undefined) {
    if (typeof payload["credits"] !== "number" || isNaN(payload["credits"] as number) || (payload["credits"] as number) < 1) {
      errors.push({ field: "credits", message: "Credits must be a positive number" });
    }
  }
  if (payload["expirationDays"] !== undefined) {
    if (typeof payload["expirationDays"] !== "number" || isNaN(payload["expirationDays"] as number) || (payload["expirationDays"] as number) < 1) {
      errors.push({ field: "expirationDays", message: "Expiration days must be a positive number" });
    }
  }
  if (payload["classIds"] !== undefined) {
    const v = validateClassIds(payload["classIds"]);
    if (!v.valid) errors.push({ field: "classIds", message: v.message ?? "" });
  }
  if (payload["isActive"] !== undefined) {
    if (typeof payload["isActive"] !== "boolean") {
      errors.push({ field: "isActive", message: "Is active must be a boolean" });
    }
  }
  if (payload["isRecurring"] !== undefined && payload["isRecurring"] !== null) {
    if (typeof payload["isRecurring"] !== "boolean") {
      errors.push({ field: "isRecurring", message: "Is recurring must be a boolean" });
    } else if (payload["isRecurring"] === true) {
      validateRecurringFields(payload, errors);
    }
  }
  if (payload["description"] !== undefined && payload["description"] !== null) {
    if (typeof payload["description"] !== "string") {
      errors.push({ field: "description", message: "Description must be a string" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Student ──────────────────────────────────────────────────────────────────

export function validateCreateStudentPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  const fnV = validateRequiredString(payload["firstName"], "First name");
  if (!fnV.valid) errors.push({ field: "firstName", message: fnV.message ?? "" });

  const lnV = validateRequiredString(payload["lastName"], "Last name");
  if (!lnV.valid) errors.push({ field: "lastName", message: lnV.message ?? "" });

  if (payload["email"] !== undefined && payload["email"] !== null && (payload["email"] as string).trim() !== "") {
    if (!isValidEmail(payload["email"])) errors.push({ field: "email", message: "Invalid email format" });
  }
  if (payload["phone"] !== undefined && payload["phone"] !== null && (payload["phone"] as string).trim() !== "") {
    const pv = validatePhone(payload["phone"]);
    if (!pv.valid) errors.push({ field: "phone", message: pv.message ?? "" });
  }
  if (payload["credits"] !== undefined && payload["credits"] !== null) {
    if (typeof payload["credits"] !== "number" || isNaN(payload["credits"] as number) || (payload["credits"] as number) < 0) {
      errors.push({ field: "credits", message: "Credits must be a non-negative number" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateStudentPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (payload["firstName"] !== undefined) {
    const v = validateRequiredString(payload["firstName"], "First name");
    if (!v.valid) errors.push({ field: "firstName", message: v.message ?? "" });
  }
  if (payload["lastName"] !== undefined) {
    const v = validateRequiredString(payload["lastName"], "Last name");
    if (!v.valid) errors.push({ field: "lastName", message: v.message ?? "" });
  }
  if (payload["email"] !== undefined && payload["email"] !== null && (payload["email"] as string).trim() !== "") {
    if (!isValidEmail(payload["email"])) errors.push({ field: "email", message: "Invalid email format" });
  }
  if (payload["phone"] !== undefined && payload["phone"] !== null && (payload["phone"] as string).trim() !== "") {
    const pv = validatePhone(payload["phone"]);
    if (!pv.valid) errors.push({ field: "phone", message: pv.message ?? "" });
  }
  if (payload["credits"] !== undefined && payload["credits"] !== null) {
    if (typeof payload["credits"] !== "number" || isNaN(payload["credits"] as number) || (payload["credits"] as number) < 0) {
      errors.push({ field: "credits", message: "Credits must be a non-negative number" });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateStudentRegistrationPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (!isValidEmail(payload["email"])) {
    errors.push({ field: "email", message: "Valid email is required" });
  }
  const passwordV = validatePassword(payload["password"]);
  if (!passwordV.valid) errors.push({ field: "password", message: passwordV.message ?? "" });

  for (const field of ["firstName", "lastName", "city"]) {
    const v = validateRequiredString(payload[field], field.charAt(0).toUpperCase() + field.slice(1));
    if (!v.valid) errors.push({ field, message: v.message ?? "" });
  }

  const stateV = validateState(payload["state"]);
  if (!stateV.valid) errors.push({ field: "state", message: stateV.message ?? "" });

  const zipV = validateZip(payload["zip"]);
  if (!zipV.valid) errors.push({ field: "zip", message: zipV.message ?? "" });

  if (payload["danceGenre"] !== undefined && payload["danceGenre"] !== null && payload["danceGenre"] !== "") {
    const gv = validateDanceGenre(payload["danceGenre"]);
    if (!gv.valid) errors.push({ field: "danceGenre", message: gv.message ?? "" });
  }
  if (payload["phone"] !== undefined && payload["phone"] !== null && (payload["phone"] as string).trim() !== "") {
    const pv = validatePhone(payload["phone"]);
    if (!pv.valid) errors.push({ field: "phone", message: pv.message ?? "" });
  }
  if (payload["subscribeToNewsletter"] !== undefined && payload["subscribeToNewsletter"] !== null) {
    if (typeof payload["subscribeToNewsletter"] !== "boolean") {
      errors.push({ field: "subscribeToNewsletter", message: "Subscribe to newsletter must be a boolean" });
    }
  }
  if (payload["avatarFile"] !== undefined && payload["avatarFile"] !== null) {
    if (typeof payload["avatarFile"] !== "string") {
      errors.push({ field: "avatarFile", message: "Avatar file must be a base64 string" });
    } else if (!payload["avatarFile"].startsWith("data:image/")) {
      errors.push({ field: "avatarFile", message: "Avatar file must be a valid base64 image data URL" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Booking ──────────────────────────────────────────────────────────────────

export function validateCreateBookingPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];

  if (!payload["instructorId"] || typeof payload["instructorId"] !== "string") {
    errors.push({ field: "instructorId", message: "Instructor ID is required" });
  }
  if (!payload["studioId"] || typeof payload["studioId"] !== "string") {
    errors.push({ field: "studioId", message: "Studio ID is required" });
  }

  if (!payload["date"] || typeof payload["date"] !== "string") {
    errors.push({ field: "date", message: "Date is required" });
  } else {
    if (!isValidDateFormat(payload["date"])) {
      errors.push({ field: "date", message: "Date must be in YYYY-MM-DD format" });
    } else if (isDateInPast(payload["date"])) {
      errors.push({ field: "date", message: "Cannot book dates in the past" });
    }
  }

  if (!payload["timeSlot"] || typeof payload["timeSlot"] !== "object") {
    errors.push({ field: "timeSlot", message: "Time slot is required" });
  } else {
    const slot = payload["timeSlot"] as Record<string, unknown>;
    if (!slot["startTime"] || typeof slot["startTime"] !== "string") {
      errors.push({ field: "timeSlot.startTime", message: "Start time is required" });
    } else if (!isValidTimeFormat(slot["startTime"])) {
      errors.push({ field: "timeSlot.startTime", message: "Start time must be in HH:mm format" });
    }
    if (!slot["endTime"] || typeof slot["endTime"] !== "string") {
      errors.push({ field: "timeSlot.endTime", message: "End time is required" });
    } else if (!isValidTimeFormat(slot["endTime"])) {
      errors.push({ field: "timeSlot.endTime", message: "End time must be in HH:mm format" });
    }
    if (slot["startTime"] && slot["endTime"] && isValidTimeFormat(slot["startTime"]) && isValidTimeFormat(slot["endTime"])) {
      const [sh, sm] = (slot["startTime"] as string).split(":").map(Number);
      const [eh, em] = (slot["endTime"] as string).split(":").map(Number);
      const startTotal = (sh ?? 0) * 60 + (sm ?? 0);
      const endTotal = (eh ?? 0) * 60 + (em ?? 0);
      if (endTotal <= startTotal) {
        errors.push({ field: "timeSlot.endTime", message: "End time must be after start time" });
      }
    }
  }

  if (payload["notes"] !== undefined && payload["notes"] !== null) {
    if (typeof payload["notes"] !== "string") {
      errors.push({ field: "notes", message: "Notes must be a string" });
    } else if ((payload["notes"] as string).length > 1000) {
      errors.push({ field: "notes", message: "Notes must be 1000 characters or less" });
    }
  }

  if (payload["contactInfo"] !== undefined && payload["contactInfo"] !== null) {
    if (typeof payload["contactInfo"] !== "object") {
      errors.push({ field: "contactInfo", message: "Contact info must be an object" });
    } else {
      const ci = payload["contactInfo"] as Record<string, unknown>;
      if (ci["email"] !== undefined && ci["email"] !== null) {
        if (typeof ci["email"] !== "string") {
          errors.push({ field: "contactInfo.email", message: "Email must be a string" });
        } else if (!isValidEmail(ci["email"])) {
          errors.push({ field: "contactInfo.email", message: "Invalid email format" });
        }
      }
      if (ci["phone"] !== undefined && ci["phone"] !== null) {
        const pv = validatePhone(ci["phone"]);
        if (!pv.valid) errors.push({ field: "contactInfo.phone", message: pv.message ?? "" });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function validateForgotPasswordPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (!isValidEmail(payload["email"])) {
    errors.push({ field: "email", message: "Valid email is required" });
  }
  return { valid: errors.length === 0, errors };
}

export function validateResetPasswordPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (!payload["oobCode"] || typeof payload["oobCode"] !== "string" || (payload["oobCode"] as string).trim().length === 0) {
    errors.push({ field: "oobCode", message: "Reset code is required" });
  }
  const passwordV = validatePassword(payload["newPassword"]);
  if (!passwordV.valid) errors.push({ field: "newPassword", message: passwordV.message ?? "" });
  return { valid: errors.length === 0, errors };
}

export function validateChangeEmailPayload(payload: Record<string, unknown>): ValidationErrors {
  const errors: ValidationErrorList = [];
  if (!payload["currentPassword"] || typeof payload["currentPassword"] !== "string" || (payload["currentPassword"] as string).trim().length === 0) {
    errors.push({ field: "currentPassword", message: "Current password is required" });
  }
  if (!isValidEmail(payload["newEmail"])) {
    errors.push({ field: "newEmail", message: "Valid email is required" });
  }
  return { valid: errors.length === 0, errors };
}
