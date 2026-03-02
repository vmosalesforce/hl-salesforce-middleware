import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_MARKETING_API_KEY
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// HEALTH CHECK
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 Middleware Running - LeadConnector Version");
});

// =======================
// REFRESH SALESFORCE TOKEN
// =======================
async function refreshAccessToken() {
  const response = await axios.post(
    "https://login.salesforce.com/services/oauth2/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: SF_REFRESH_TOKEN
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + 1000 * 60 * 90;

  console.log("🔄 Salesforce token refreshed");
}

// ======================================================
// HL ➜ SF ➜ XO MARKETING
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;
    const hlContactId = hlData.High_Level_ID__c;

    if (!hlContactId) {
      return res.status(200).json({ skipped: true });
    }

    const firstName = hlData.FirstName || "";
    const lastName = hlData.LastName || "Unknown";
    const email = hlData.Email || null;
    const phone = hlData.Phone || null;

    // 🔎 Check if SF contact already exists
    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id FROM Contact WHERE High_Level_ID__c = '${hlContactId}' LIMIT 1`
        }
      }
    );

    // If contact exists, STOP (prevents replay storm)
    if (query.data.records.length > 0) {
      console.log("⏭ Existing SF contact — skipping Marketing");
      return res.status(200).json({ success: true });
    }

    // Create Salesforce Contact
    const create = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: firstName,
        LastName: lastName,
        Email: email,
        Phone: phone,
        High_Level_ID__c: hlContactId,
        Origin_From_HL_c__c: true
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const sfContactId = create.data.id;
    console.log("✅ Created in Salesforce:", sfContactId);

    // Send to XO Marketing
    await sendToMarketing(firstName, lastName, email, phone, sfContactId);

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true }); // Always 200 to stop HL retries
  }
});

// ======================================================
// SEND TO XO MARKETING (LeadConnector API)
// ======================================================
async function sendToMarketing(firstName, lastName, email, phone, sfContactId) {

  console.log("📤 Sending to XO Marketing");

  await new Promise(resolve => setTimeout(resolve, 2000));

  try {

    const create = await axios.post(
      "https://services.leadconnectorhq.com/contacts/",
      {
        locationId: "b14865bIx5lk78TWHm7n",
        firstName,
        lastName,
        email,
        phone,
        customFields: [
          {
            key: "salesforce_contact_id",
            value: sfContactId
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HL_MARKETING_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json"
        }
      }
    );

    const marketingId = create.data.contact.id;
    console.log("✅ Created Marketing contact:", marketingId);

    // Write Marketing ID back to Salesforce
    await axios.patch(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfContactId}`,
      { XO_Marketing_High_Level_ID__c: marketingId },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("🔁 Marketing ID written back to Salesforce");

  } catch (err) {
    console.log("❌ Marketing error:", err.response?.data || err.message);
  }
}

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
