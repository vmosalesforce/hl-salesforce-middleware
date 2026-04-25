import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_API_KEY,
  HL_LOCATION_ID,
  HL_MARRIAGE_API_KEY,
  HL_MARRIAGE_LOCATION_ID
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// HEALTH CHECK
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF Middleware Running");
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
// HL ➜ SF
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

    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id FROM Contact WHERE High_Level_ID__c = '${hlContactId}' LIMIT 1`
        }
      }
    );

    if (query.data.records.length > 0) {
      console.log("⏭ Existing SF contact found");
      return res.status(200).json({ success: true });
    }

    await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: hlData.FirstName || "",
        LastName: hlData.LastName || "Unknown",
        Email: hlData.Email || null,
        Phone: hlData.Phone || null,
        HomePhone: hlData.HomePhone || null,
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

    console.log("✅ Contact created in Salesforce");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

// ======================================================
// SF ➜ HL WRITEBACK ONLY
// Only runs when the Salesforce Contact was created from HL first
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ HL writeback received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    if (!sfData.Id) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing Salesforce Contact Id"
      });
    }

    const sfContactResponse = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfData.Id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const contact = sfContactResponse.data;

    // ======================================================
    // STOP ORGANIC SALESFORCE CONTACTS
    // ======================================================
    if (contact.Origin_From_HL_c__c !== true) {
      console.log("⏭ Skipped: Organic Salesforce contact. Not sent to HighLevel.");
      return res.status(200).json({
        skipped: true,
        reason: "Organic Salesforce contact - not sent to HighLevel"
      });
    }

    if (!contact.Email) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing email"
      });
    }

    // =======================
    // TAGS - Marketing Only
    // =======================
    const donorSegment = contact.HighLevel_Donor_Segments__c;

    let tagToApply = ["HL Via Salesforce"];

    if (donorSegment === "Mid Donor") tagToApply.push("SF Mid Donor");
    if (donorSegment === "Low Donor") tagToApply.push("SF Low Donor");
    if (donorSegment === "Non-Donor") tagToApply.push("SF Non-Donor");
    if (donorSegment === "Major Donor") tagToApply.push("SF Major Donor");

    if (contact.VR__c) {
      tagToApply.push("SF Vision Retreat Attendee");
    }

    if (contact.Conferences__c) {
      tagToApply.push("SF Conference Attendee");
    }

    if (contact.Shopify_Segment__c && contact.Shopify_Segment__c !== "No Shopify") {
      tagToApply.push("SF Shopify Buyer");
    }

    console.log("📤 Writing back to XO Marketing with tags:", tagToApply);

    // ======================================================
    // 1️⃣ XO MARKETING
    // ======================================================
    const marketingResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: HL_LOCATION_ID,
        email: contact.Email,
        firstName: contact.FirstName || "",
        lastName: contact.LastName || "Unknown",
        phone: contact.Phone || contact.HomePhone || null,
        tags: tagToApply
      },
      {
        headers: {
          Authorization: `Bearer ${HL_API_KEY}`,
          Version: "2021-04-15",
          "Content-Type": "application/json"
        }
      }
    );

    const marketingHLId = marketingResponse.data.contact?.id;

    if (marketingHLId) {
      await axios.put(
        `https://services.leadconnectorhq.com/contacts/${marketingHLId}`,
        {
          customFields: [
            {
              id: "0w8kYzW7XY8L0rRwxEHA",
              value: contact.Id
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${HL_API_KEY}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      await axios.patch(
        `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${contact.Id}`,
        {
          XO_Marketing_High_Level_ID__c: marketingHLId
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("✅ Marketing writeback complete");
    }

    // ======================================================
    // 2️⃣ XO MARRIAGE
    // ======================================================
    console.log("📤 Writing back to XO Marriage");

    const marriageResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: HL_MARRIAGE_LOCATION_ID,
        email: contact.Email,
        firstName: contact.FirstName || "",
        lastName: contact.LastName || "Unknown",
        phone: contact.Phone || contact.HomePhone || null
      },
      {
        headers: {
          Authorization: `Bearer ${HL_MARRIAGE_API_KEY}`,
          Version: "2021-04-15",
          "Content-Type": "application/json"
        }
      }
    );

    const marriageHLId = marriageResponse.data.contact?.id;

    if (marriageHLId) {
      await axios.put(
        `https://services.leadconnectorhq.com/contacts/${marriageHLId}`,
        {
          customFields: [
            {
              id: "OgA23wE1DwCjXitTl41d",
              value: contact.Id
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${HL_MARRIAGE_API_KEY}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      await axios.patch(
        `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${contact.Id}`,
        {
          High_Level_ID__c: marriageHLId
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("✅ Marriage writeback complete");
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ HL Writeback Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
