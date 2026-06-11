/**
 * Test env — config.ts validates on import, so these must exist before any
 * module under src/ is loaded. Values are dummies; tests never hit real APIs.
 */
process.env.AIRTABLE_PAT = "patTESTONLY000000";
process.env.AIRTABLE_BASE_ID = "appTESTONLY000000";
process.env.INTERNAL_JOB_SECRET = "test-secret-0123456789abcdef";
process.env.STRIPE_API_KEY = "rk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
process.env.NODE_ENV = "test";
