/**
 * Test env — config.ts validates on import, so these must exist before any
 * module under src/ is loaded. Values are dummies; tests never hit real APIs.
 */
process.env.AIRTABLE_PAT = "patTESTONLY000000";
process.env.AIRTABLE_BASE_ID = "appTESTONLY000000";
process.env.INTERNAL_JOB_SECRET = "test-secret-0123456789abcdef";
process.env.STRIPE_API_KEY = "rk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
process.env.SHOPIFY_STORE_DOMAIN = "test-store.myshopify.com";
process.env.SHOPIFY_APP_CLIENT_ID = "shopify_client_id_test_dummy";
process.env.SHOPIFY_APP_CLIENT_SECRET = "shopify_client_secret_test_dummy";
process.env.SHOPIFY_WEBHOOK_SECRET = "whsec_shopify_testsecret";
process.env.SHIPSTATION_API_KEY = "shipstation_test_dummy";
process.env.SHIPSTATION_WEBHOOK_SECRET = "shipstation_webhook_testsecret";
process.env.SHIPSTATION_WAREHOUSE_ID = "se-test-warehouse";
process.env.QUICKBOOKS_REALM_ID = "9341453935816320";
process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = "qb_webhook_verifier_token_test";
process.env.NODE_ENV = "test";
