# DanceUP — Manual QA Testing Checklist

## How to Use This Checklist

- **Gate 1 (Dev → Staging):** Run the full regression before every staging deployment. Every checkbox must be checked or explicitly noted as N/A with a reason. Failures block promotion.
- **Gate 2 (Staging → Production):** Run the smoke test + verify the specific changed areas for this release. Gate 2 is intentionally short — the full regression already happened at Gate 1.
- Copy the sign-off block at the bottom of each gate into your release notes or ticket before merging.
- Reset checkboxes between releases (find-replace `[x]` → `[ ]`).

---

## Environment Quick Reference

| | Dev | Staging | Production |
|---|---|---|---|
| Firebase project | `dev-danceup` | `staging-danceup` | `production-danceup` |
| Stripe mode | Test keys | Test keys | **Live keys** |
| Studio owners app | localhost:4200 | staging URL | prod URL |
| Users app | localhost:4201 | staging URL | prod URL |
| Cloud Functions | localhost:5001 | staging functions | prod functions |
| Firestore emulator | localhost:8080 | — | — |

> **Stripe test cards:** `4242 4242 4242 4242` (no 3DS) · `4000 0025 0000 3155` (3DS required) · any future expiry · any CVC

---

---

# GATE 1: Dev → Staging — Full Regression

---

## Pre-flight

- [ ] `firebase deploy --only firestore:rules` completes without errors
- [ ] `firebase deploy --only firestore:indexes` completes without errors
- [ ] `ng build` in `studio-owners-app/` — zero TypeScript or build errors
- [ ] `ng build` in `users-app/` — zero TypeScript or build errors
- [ ] Cloud Functions deploy without errors (`firebase deploy --only functions`)
- [ ] No secrets or `.env` files committed to git (`git log --oneline -5` — check diff)
- [ ] No browser console errors on initial load of studio-owners-app
- [ ] No browser console errors on initial load of users-app
- [ ] Both apps resolve to the correct Firebase project (`dev-danceup`) — verify in browser network tab by checking Auth/Firestore hostnames

---

## Backend — Auth

- [ ] Studio owner: register new account → receives custom Firebase token → can log in immediately
- [ ] Studio owner: login with correct credentials — dashboard loads
- [ ] Studio owner: login with wrong password → returns a user-friendly error message (not a raw 500)
- [ ] Studio owner: forgot-password → email received → link navigates to reset page → new password accepted → login works
- [ ] Studio owner: change-email flow completes successfully
- [ ] Student: register new account — profile created
- [ ] Student: login with email/password
- [ ] Student: login with Google OAuth
- [ ] Student: forgot-password / reset-password flow

---

## Backend — Classes

- [ ] Create class (name, cost, dayOfWeek, startTime, endTime, room, instructor assignment, description)
- [ ] List classes for authenticated studio owner — returns correct records
- [ ] Edit class — changes persisted on refetch
- [ ] Delete class — removed from list
- [ ] `GET /classes/public` — returns results without authentication

---

## Backend — Workshops

- [ ] Create workshop (name, levels, startTime, endTime, description, locationName, addressLine1, city, image upload)
- [ ] List workshops
- [ ] Edit workshop — changes saved
- [ ] Delete workshop
- [ ] `GET /workshops/public` — works without auth, filters (level, location, price, dates) respected
- [ ] Manage workshop endpoint returns attendee list
- [ ] Workshop report endpoint returns data

---

## Backend — Events

- [ ] Create event (name, type, startTime, endTime, description, location fields, image upload)
- [ ] List events
- [ ] Edit event — changes saved
- [ ] Delete event
- [ ] `GET /events/public` — works without auth, filters (type, city, price range, dates) respected
- [ ] Manage event endpoint works
- [ ] Event report endpoint returns data

---

## Backend — Packages

- [ ] Create package (name, price, credits, expirationDays, description, isRecurring, isActive)
- [ ] List packages for authenticated studio owner
- [ ] Edit package — changes saved
- [ ] Delete package
- [ ] Package visible to student browsing the studio in users-app

---

## Backend — Instructors

- [ ] Create instructor (firstName, lastName, email, phone, bio, photo upload, availableForPrivates)
- [ ] List instructors — correct records returned
- [ ] Edit instructor — changes saved
- [ ] Delete instructor — removed from list
- [ ] Instructor appears on public studio detail page in users-app

---

## Backend — Studios

- [ ] GET studio for authenticated owner — correct profile data returned
- [ ] Update studio profile (name, address, image, social links) — changes persisted
- [ ] `GET /studios/public` — list and search work without auth
- [ ] Student enrolls in studio → enrollment stored and reflected
- [ ] Student unenrolls from studio
- [ ] Enrollment status check endpoint returns correct state

---

## Backend — Students (studio owner view)

- [ ] GET all students for studio — list returns
- [ ] GET student detail — enrollment info, attendance, purchases present
- [ ] Remove student from studio

---

## Backend — Attendance

- [ ] Mark student attended for a class (`POST /attendance/classes/:classId`)
- [ ] Attendance stats return weekly, monthly, and per-class breakdowns
- [ ] Student-level attendance history retrievable

---

## Backend — Reviews

- [ ] Student submits review for a class
- [ ] Student submits review for an instructor
- [ ] Student submits review for a studio
- [ ] Reviews appear in studio owner's reviews analytics page
- [ ] Studio owner can delete a review
- [ ] Average rating calculated correctly

---

## Backend — Bookings

- [ ] Student creates private lesson booking
- [ ] Studio owner sees new booking in their list
- [ ] Studio owner confirms booking
- [ ] Studio owner cancels booking
- [ ] Studio owner reschedules booking
- [ ] Studio owner marks booking as attended

---

## Backend — Purchases & Stripe (test mode)

- [ ] Create payment link for a class → Stripe link returned
- [ ] Create payment link for an event → Stripe link returned
- [ ] Create payment link for a workshop → Stripe link returned
- [ ] Create payment link for a package → Stripe link returned
- [ ] Complete Stripe test checkout → confirm purchase endpoint stores record in Firestore
- [ ] Purchase history returns correct transactions for student
- [ ] Refund eligibility check works
- [ ] Process refund → Stripe test refund issued, record updated
- [ ] Stripe Connect account creation for a new studio owner
- [ ] Save payment method via setup intent (Stripe Elements card form)
- [ ] Charge with saved card — use `4000 0025 0000 3155` to trigger 3DS, confirm it completes
- [ ] Remove saved payment method — no longer listed
- [ ] Stripe webhook endpoint receives `payment_intent.succeeded` and processes correctly (check function logs)

---

## Backend — Marketing & Email

- [ ] GET recipients — returns subscribed students for the studio
- [ ] POST send-campaign → SendGrid delivers (check recipient inbox or SendGrid Activity Feed)
- [ ] `GET /unsubscribe/:token` — removes student from marketing list, subsequent campaign does not include them

---

## Backend — Notifications

- [ ] Notification created after a relevant action (e.g., new booking received)
- [ ] GET notifications — returns paginated list, 90-day filter respected
- [ ] PATCH notification — marked as read

---

## Backend — Support

- [ ] Studio owner submits support issue → record appears in `support_issues` Firestore collection

---

## Backend — Scheduled Jobs

- [ ] `expireCredits` Cloud Scheduler job is active in the dev/staging Firebase project (check Cloud Scheduler in Firebase Console)
- [ ] Manually trigger the function → runs without errors (check `firebase functions:log`)

---

## Studio Owners App — Auth & Role-Based Access

- [ ] Login page: email + password fields accept input, submit button logs user in
- [ ] Forgot password → reset email received → link → new password set → login works
- [ ] Role `individual_instructor`: Classes nav item visible; Workshops, Events, Packages, Instructors items hidden
- [ ] Role `studio_owner`: Classes + Instructors + analytics visible; pro-plus gated items hidden
- [ ] Role `studio_owner_pro_plus`: full nav — all sections visible
- [ ] Unauthenticated user visiting `/dashboard/content/classes` → redirected to `/login`
- [ ] Logout clears session → redirected to `/login` → browser back button does not re-enter dashboard

---

## Studio Owners App — Dashboard

- [ ] Overview page loads, stat tiles render with data
- [ ] No broken images anywhere on the page
- [ ] No browser console errors
- [ ] Sidebar icons all render (not showing as plain circles): home, academic-cap, sparkles, calendar, cube, chart-bar, currency-dollar, star, user-group, envelope, building-office, credit-card, exclamation-triangle, book-open

---

## Studio Owners App — Classes

- [ ] Classes list page loads with existing classes
- [ ] Create class: required field validation triggers on empty submit; valid form submits; new class appears in list
- [ ] Edit class: form pre-fills with existing data; save updates the record
- [ ] Delete class: item removed from list

---

## Studio Owners App — Workshops

- [ ] Workshops list page loads
- [ ] Create workshop: all required fields, image upload, form submits successfully
- [ ] Edit workshop: changes saved
- [ ] Delete workshop
- [ ] Manage workshop page: attendee list loads
- [ ] Workshop report page loads

---

## Studio Owners App — Events

- [ ] Events list page loads
- [ ] Create event: all fields including image upload, submit succeeds
- [ ] Edit event: changes saved
- [ ] Delete event
- [ ] Manage event page loads
- [ ] Event report page loads

---

## Studio Owners App — Packages

- [ ] Packages list loads
- [ ] Create package: price, credits, expiration days, recurring toggle — submit succeeds
- [ ] Edit package: changes saved
- [ ] Delete package

---

## Studio Owners App — Attendance Analytics

- [ ] Page loads, charts render correctly
- [ ] Class-level breakdown section shows per-class stats
- [ ] Date range filtering changes displayed data (if filter present)

---

## Studio Owners App — Revenue Analytics

- [ ] Page loads, revenue totals displayed
- [ ] Breakdown by category (tuition, packages, events, etc.) visible

---

## Studio Owners App — Reviews

- [ ] Reviews list loads with student reviews
- [ ] Average rating badge shows correct value

---

## Studio Owners App — Students

- [ ] Students list loads
- [ ] Student detail page: enrollment info, attendance records, purchases all present
- [ ] Search or filter works (if implemented)

---

## Studio Owners App — Instructors

- [ ] Instructors list loads
- [ ] Add instructor: all fields, photo upload, submit succeeds — instructor appears in list
- [ ] Edit instructor: form pre-fills, changes saved
- [ ] Delete instructor: removed from list

---

## Studio Owners App — Email Campaigns

- [ ] Campaigns list loads
- [ ] Create campaign: subject field, audience selector, rich text editor all load and accept input
- [ ] Send campaign → SendGrid delivers (check inbox or SendGrid Activity Feed)
- [ ] Campaign stats page: open rate and click rate displayed

---

## Studio Owners App — Settings / Studio Profile

- [ ] Profile page loads with existing data pre-filled in all fields
- [ ] Update owner name, studio name, address → saved and reflected after page reload
- [ ] Studio image upload → new image shown in preview after save
- [ ] Facebook, Instagram, TikTok links save and persist

---

## Studio Owners App — Billing

- [ ] Billing page loads without errors
- [ ] Current subscription plan displayed correctly

---

## Studio Owners App — Notifications

- [ ] Bell icon shows unread count badge when notifications exist
- [ ] Notifications page lists items
- [ ] Clicking a notification (or marking read) decrements the badge

---

## Studio Owners App — Support

- [ ] Report Issue form loads, submits, confirmation page shown
- [ ] Guides index page: all 13 guide cards visible, grouped into correct sections
- [ ] Each guide detail page: breadcrumb, hero title, numbered steps load
- [ ] Required/Optional and field type badges render per step
- [ ] Guide screenshots render (no broken image links)
- [ ] "Back to all guides" link returns to guides index

---

## Users App — Auth

- [ ] Register new student: form validates, account created successfully
- [ ] Login with email/password
- [ ] Login with Google OAuth
- [ ] Forgot password → reset email → new password works
- [ ] Unauthenticated user on a protected route → redirected to login

---

## Users App — Studios

- [ ] Studios browse page loads with results
- [ ] Studio detail page: classes, instructors, and packages all load
- [ ] Instructor profile page loads
- [ ] Enroll in studio → enrollment confirmed
- [ ] Unenroll from studio
- [ ] Enrollment status reflected correctly in user dashboard

---

## Users App — Classes

- [ ] Classes browse page loads
- [ ] Enrolled classes appear on user dashboard

---

## Users App — Events

- [ ] Events browse page loads with results
- [ ] Event detail page: description, pricing tiers, and dates all visible
- [ ] Purchase event ticket → Stripe checkout → success redirect → event appears in purchase history
- [ ] Purchased event appears on user dashboard

---

## Users App — Workshops

- [ ] Workshops browse page loads
- [ ] Workshop detail page loads with full details
- [ ] Purchase workshop → Stripe checkout → confirmed in purchase history

---

## Users App — Packages

- [ ] Studio packages page loads for a given studio
- [ ] Purchase package → Stripe checkout → credits appear in purchase history

---

## Users App — Bookings (Private Lessons)

- [ ] Book private lesson with instructor: date/time selection, form submits
- [ ] Booking confirmation page shows correct instructor, date, and time
- [ ] Booking appears in studio owner's bookings list

---

## Users App — Profile

- [ ] Profile page loads with current data
- [ ] Update name and location → saved
- [ ] Upload profile photo → new image displayed

---

## Users App — Payment Methods

- [ ] Add card via Stripe Elements form → card saved to account
- [ ] Saved card appears in payment methods list
- [ ] Delete saved card — removed from list
- [ ] Charge with saved card during a purchase succeeds (including 3DS prompt if card triggers it)

---

## Users App — Purchase History

- [ ] Purchase history page loads and lists transactions
- [ ] Each transaction shows correct amount, date, and item name

---

## Users App — Reviews

- [ ] Submit review for a class → appears in studio owner reviews dashboard
- [ ] Submit review for an instructor → appears in studio owner reviews dashboard
- [ ] Submit review for a studio → appears in studio owner reviews dashboard

---

## Users App — Dashboard

- [ ] Enrolled studios section shows correct studios
- [ ] My classes, my workshops, my events sections all load
- [ ] Event passes section loads

---

## Cross-Cutting

- [ ] **Image uploads:** studio image, workshop image, event image, instructor photo, user profile photo — all upload successfully and render correctly in the UI
- [ ] **Firebase project targeting:** verify both apps are hitting `dev-danceup` — check Firestore and Auth request URLs in browser network tab
- [ ] **Firestore security rules:** unauthenticated read of the `attendance` collection is rejected (test via Firestore REST API or emulator rules playground)
- [ ] **404 handling:** unknown route in studio-owners-app shows 404 page
- [ ] **404 handling:** unknown route in users-app shows 404 page
- [ ] **Mobile (375px):** login flow, purchase flow, and main dashboard are usable — test in browser devtools device simulation or on a real device

---

## Gate 1 Sign-Off

```
Date:            _______________
Tester:          _______________
Environment:     Dev → Staging
Build / commit:  _______________
Failures found:  _______________
Notes:           _______________

Approved to promote:  [ ] Yes   [ ] No — blocked by: _______________
```

---
---

# GATE 2: Staging → Production — Smoke Test

---

## Pre-flight

- [ ] Confirm active Firebase project alias is `production` (`cat danceup-backend/.firebaserc`)
- [ ] Confirm Stripe keys in the production environment config are **LIVE** (not test/`sk_test_`)
- [ ] Confirm Stripe webhook endpoint is registered for the production Cloud Functions URL (check Stripe Dashboard → Webhooks)
- [ ] Confirm SendGrid sender domain is verified for production sending
- [ ] Deploy Firestore rules to production **first**: `firebase deploy --only firestore:rules --project production`
- [ ] Deploy Firestore indexes to production: `firebase deploy --only firestore:indexes --project production`
- [ ] Create git release tag: `git tag prod-YYYY-MM-DD && git push origin prod-YYYY-MM-DD`
- [ ] Note the previous stable tag for rollback: `prev stable = _______________`
- [ ] `expireCredits` Cloud Scheduler job is active in `production-danceup` (verify in Firebase Console → Cloud Scheduler)

---

## Critical Path Smoke Test

- [ ] Studio owner logs in to the production studio-owners-app — dashboard loads
- [ ] Dashboard shows no errors, no broken images, sidebar icons all render
- [ ] Create one test class → appears in classes list → delete it (clean up)
- [ ] Student logs in to the production users-app
- [ ] Student browses studios — at least one studio visible
- [ ] Student enrolls in a studio → enrollment confirmed
- [ ] Student completes a **real small-amount** Stripe purchase with a live card → charge visible in Stripe production Dashboard
- [ ] Stripe webhook received and processed — check Firebase function logs (`firebase functions:log --project production`) for successful event handling
- [ ] Studio owner sends one marketing email to a real address → received in inbox
- [ ] Studio owner submits a support issue → record appears in production Firestore `support_issues` collection

---

## Changed Areas This Release

*(Before deploying, list each feature or fix that changed. Verify each one specifically after deploy.)*

- [ ] Changed area: _______________
- [ ] Changed area: _______________
- [ ] Changed area: _______________
- [ ] Changed area: _______________

---

## Gate 2 Sign-Off

```
Date:                          _______________
Tester:                        _______________
Environment:                   Staging → Production
Build / commit:                _______________
Prev stable tag (rollback to): _______________
Stripe live charge confirmed
  (last 4 digits of card):     _______________
Function logs checked:         [ ] Yes  [ ] Errors found: _______________
Failures found:                _______________
Notes:                         _______________

Approved to promote:  [ ] Yes   [ ] No — blocked by: _______________
```

---
---

# Recommended Practices

1. **Tag every deploy** — `git tag staging-YYYY-MM-DD` before every staging deploy and `git tag prod-YYYY-MM-DD` before every production deploy. Each tag is a clean rollback point.

2. **Keep a CHANGELOG** — One entry per release covering what changed, what was fixed, and known issues. This makes filling out the "Changed Areas" section trivial and gives studio owners visibility into updates.

3. **Deploy Firestore rules and indexes before functions** — Always in this order: rules → indexes → functions. Deploying functions first creates a window where new writes may be made that the old rules reject.

4. **Stripe test cards on dev and staging only** — Never run live charges outside production. Use `4242 4242 4242 4242` for happy-path and `4000 0025 0000 3155` for 3DS. Gate 2 is the only place a real card is used.

5. **Separate SendGrid subdomains per environment** — Use `mail-staging.danceup.app` for staging sends to avoid test email volume affecting your production sender reputation and deliverability score.

6. **Screenshot the Stripe Dashboard before every production deploy** — Capture the Webhooks page (recent deliveries, success rate) and the Payments overview. If something breaks post-deploy you have a before/after comparison.

7. **Check Cloud Function logs within 5 minutes of every production deploy** — `firebase functions:log --project production` — cold-start failures and misconfigured environment variables show up immediately.

8. **Rotate compromised secrets immediately** — If a Stripe key, SendGrid API key, or Firebase service account is ever committed to git (even to a private repo), rotate it in the provider dashboard before anything else. The repository history doesn't matter; the key is compromised.

9. **Verify `expireCredits` after every production deploy** — Open Firebase Console → Cloud Scheduler and confirm the job is enabled and the next scheduled run shows a future time. A disabled scheduler silently stops credit expiration.

10. **Test the purchase flow on a real mobile device before Gate 2** — Stripe Elements and Firebase Auth behave differently on mobile Safari and Android Chrome (keyboard dismissal, 3DS redirects, back-button navigation). Run the full checkout at least once on a real device.
