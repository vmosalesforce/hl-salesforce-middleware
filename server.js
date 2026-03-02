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
  res.status(200).send("🚀 Middleware Running - Stable Version");
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
// ROUTE 1: HL ➜ SF ➜ XO Marketing
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
      return res.status(200).json({ skipped: "Missing HL ID" });
    }

    const firstName = hlData.FirstName || "";
    const lastName = hlData.LastName || "Unknown";
    const email = hlData.Email || null;
    const phone = hlData.Phone || null;

    // 🔎 Check Salesforce
    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id, XO_Marketing_High_Level_ID__c
              FROM Contact
              WHERE High_Level_ID__c = '${hlContactId}'
              LIMIT 1`
        }
      }
    );

    let sfContactId;
    let marketingLinked = false;

    if (query.data.records.length > 0) {
      sfContactId = query.data.records[0].Id;
      marketingLinked = !!query.data.records[0].XO_Marketing_High_Level_ID__c;
      console.log("⏭ Existing SF contact:", sfContactId);
    } else {
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

      sfContactId = create.data.id;
      console.log("✅ Created in Salesforce:", sfContactId);
    }

    if (!marketingLinked) {
      await sendToMarketing(firstName, lastName, email, phone, sfContactId);
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    res.status(500).json({ error: "HL ➜ SF failed" });
  }
});

// ======================================================
// ROUTE 2: ORGANIC SF ➜ XO MARKETING
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ XO Marketing received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    // Prevent HL-originated contacts from double send
    if (sfData.High_Level_ID__c) {
      console.log("⏭ Skipping HL-originated contact");
      return res.status(200).json({ skipped: "HL origin" });
    }

    // Skip if already linked
    if (sfData.XO_Marketing_High_Level_ID__c) {
      console.log("⏭ Already linked to Marketing");
      return res.status(200).json({ skipped: "Already linked" });
    }

    if (!sfData.Email && !sfData.Phone) {
      return res.status(400).json({ error: "Email or Phone required" });
    }

    await sendToMarketing(
      sfData.FirstName,
      sfData.LastName,
      sfData.Email,
      sfData.Phone,
      sfData.Id
    );

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ Marketing Error:", error.response?.data || error.message);
    res.status(500).json({ error: "SF ➜ Marketing failed" });
  }
});

// ======================================================
// SEND TO XO MARKETING (Create-first, search-if-needed)
// ======================================================
async function sendToMarketing(firstName, lastName, email, phone, sfContactId) {

  console.log("📤 Sending to XO Marketing");

  await new Promise(resolve => setTimeout(resolve, 1200));

  let marketingId;

  try {
    const create = await axios.post(
      "https://rest.gohighlevel.com/v1/contacts/",
      {
        firstName,
        lastName,
        email,
        phone,
        customField: [
          {
            key: "salesforce_contact_id",
            value: sfContactId
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HL_MARKETING_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    marketingId = create.data.contact.id;
    console.log("✅ Created Marketing contact:", marketingId);

  } catch (err) {

    if (err.response?.data?.message?.includes("already exists")) {

      console.log("⏭ Marketing contact already exists — fetching");

      const search = await axios.get(
        "https://rest.gohighlevel.com/v1/contacts/search",
        {
          headers: {
            Authorization: `Bearer ${HL_MARKETING_API_KEY}`,
            "Content-Type": "application/json"
          },
          params: { email }
        }
      );

      if (search.data.contacts && search.data.contacts.length > 0) {
        marketingId = search.data.contacts[0].id;
      }

    } else {
      throw err;
    }
  }

  if (!marketingId) {
    console.log("⚠️ No Marketing ID found");
    return;
  }

  await axios.patch(
    `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfContactId}`,
    {
      XO_Marketing_High_Level_ID__c: marketingId
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("🔁 Marketing ID written back to Salesforce");
}

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
