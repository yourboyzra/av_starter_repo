import { config } from "dotenv";
config({ override: true });

import { getAccessToken } from "../src/lib/oauth.js";

const realmId = process.env.QUICKBOOKS_REALM_ID!;
const token = await getAccessToken("quickbooks", realmId);

const res = await fetch(
  `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/query?query=select%20*%20from%20Account%20MAXRESULTS%20100`,
  { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
);

const data = await res.json() as { QueryResponse?: { Account?: { Id: string; Name: string; AccountType: string; Classification: string; Active: boolean }[] } };
const accounts = data.QueryResponse?.Account ?? [];

console.log("\nAll accounts:\n");
for (const a of accounts.filter(a => a.Active)) {
  console.log(`Id: ${a.Id.padEnd(6)} | Type: ${a.AccountType.padEnd(30)} | Classification: ${a.Classification.padEnd(12)} | Name: ${a.Name}`);
}
