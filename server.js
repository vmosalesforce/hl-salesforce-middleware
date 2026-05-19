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
  HL_LOCATION_ID
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

const SALESFORCE_MANAGED_TAGS = [
  "HL Via Salesforce",
  "Manual Send to XO Marketing",
  "SF Mid Donor",
  "SF Low Donor",
  "SF Non-Donor",
  "SF Major Donor",
  "SF Vision Retreat Attendee",
  "SF Conference Attendee",
  "SF Shopify Buyer"
];

app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF Middleware Running - Marketing Only");
});

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

function parseDndValue(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

// ======================================================
// HL MARKETING ➜ SALESFORCE
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL Marketing ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;
    console.log("📦 HL Payload:", JSON.stringify(hlData, null, 2));

    const hlContactId = hlData.High_Level_ID__c;
    const dndValue = parseDndValue(hlData.dnd);

    if (!hlContactId) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing HighLevel Contact Id"
      });
    }

    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id FROM Contact WHERE XO_Marketing_High_Level_ID__c = '${hlContactId}' LIMIT 1`
        }
      }
    );

    if (query.data.records.length > 0) {
      const sfContactId = query.data.records[0].Id;

      if (dndValue !== null) {
        await axios.patch(
          `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfContactId}`,
          {
            HasOptedOutOfEmail: dndValue
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            }
          }
        );

        console.log(`✅ Salesforce Email Opt Out updated to ${dndValue}`);
      } else {
        console.log("⏭ Existing Salesforce Contact found. No DND value sent.");
      }

      return res.status(200).json({
        success: true,
        message: "Existing Salesforce Contact processed"
      });
    }

    const newContactBody = {
      FirstName: hlData.FirstName || "",
      LastName: hlData.LastName || "Unknown",
      Email: hlData.Email || null,
      Phone: hlData.Phone || null,
      HomePhone: hlData.HomePhone || null,
      XO_Marketing_High_Level_ID__c: hlContactId,
      Origin_From_HL_c__c: true
    };

    if (dndValue !== null) {
      newContactBody.HasOptedOutOfEmail = dndValue;
    }

    await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      newContactBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Contact created in Salesforce from HL Marketing");

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// SF ➜ HL MARKETING WRITEBACK / TAG UPDATE
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ HL Marketing writeback received");

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

    if (
      contact.Origin_From_HL_c__c !== true &&
      !contact.XO_Marketing_High_Level_ID__c
    ) {
      console.log("⏭ Skipped: Organic Salesforce contact not connected to XO Marketing.");

      return res.status(200).json({
        skipped: true,
        reason: "Organic Salesforce contact not connected to XO Marketing"
      });
    }

    return await sendToMarketingHighLevel(contact, res, false);

  } catch (error) {
    console.error("❌ SF ➜ HL Marketing Error:", error.response?.data || error.message);

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// MANUAL BUTTON ➜ XO MARKETING ONLY
// ======================================================
app.post("/manual-xo-marketing", async (req, res) => {
  try {
    console.log("📩 Manual SF Button ➜ XO Marketing received");

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

    return await sendToMarketingHighLevel(contact, res, true);

  } catch (error) {
    console.error("❌ Manual XO Marketing Error:", error.response?.data || error.message);

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

function buildSalesforceTags(contact, isManualSend) {
  const donorSegment = contact.HighLevel_Donor_Segments__c || "";
  const shopifySegment = contact.Shopify_Segment__c || "";

  let tags = ["HL Via Salesforce"];

  if (isManualSend) tags.push("Manual Send to XO Marketing");

  if (donorSegment.includes("Mid")) tags.push("SF Mid Donor");
  if (donorSegment.includes("Low")) tags.push("SF Low Donor");
  if (donorSegment.includes("Non")) tags.push("SF Non-Donor");

  if (donorSegment.includes("High") || donorSegment.includes("Major")) {
    tags.push("SF Major Donor");
  }

  if (contact.VR__c) tags.push("SF Vision Retreat Attendee");
  if (contact.Conferences__c) tags.push("SF Conference Attendee");

  if (shopifySegment && shopifySegment !== "No Shopify") {
    tags.push("SF Shopify Buyer");
  }

  return tags;
}

async function sendToMarketingHighLevel(contact, res, isManualSend) {
  if (!contact.Email) {
    return res.status(200).json({
      skipped: true,
      reason: "Missing email"
    });
  }

  const newSalesforceTags = buildSalesforceTags(contact, isManualSend);
  console.log("🏷 New Salesforce tags:", newSalesforceTags);

  const marketingResponse = await axios.post(
    "https://services.leadconnectorhq.com/contacts/upsert",
    {
      locationId: HL_LOCATION_ID,
      email: contact.Email,
      firstName: contact.FirstName || "",
      lastName: contact.LastName || "Unknown",
      phone: contact.Phone || contact.HomePhone || null,
      tags: newSalesforceTags
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

  if (!marketingHLId) {
    return res.status(200).json({
      handled: true,
      reason: "HighLevel did not return a contact id"
    });
  }

  const hlContactResponse = await axios.get(
    `https://services.leadconnectorhq.com/contacts/${marketingHLId}`,
    {
      headers: {
        Authorization: `Bearer ${HL_API_KEY}`,
        Version: "2021-04-15",
        "Content-Type": "application/json"
      }
    }
  );

  const currentTags =
    hlContactResponse.data.contact?.tags ||
    hlContactResponse.data.tags ||
    [];

  const preservedHighLevelTags = currentTags.filter(
    tag =>
      !SALESFORCE_MANAGED_TAGS.some(
        managedTag => managedTag.toLowerCase() === String(tag).toLowerCase()
      )
  );

  const finalTags = [
    ...new Set([
      ...preservedHighLevelTags,
      ...newSalesforceTags
    ])
  ];

  console.log("🧹 Preserved HL-only tags:", preservedHighLevelTags);
  console.log("✅ Final tags after cleanup:", finalTags);

  await axios.put(
    `https://services.leadconnectorhq.com/contacts/${marketingHLId}`,
    {
      firstName: contact.FirstName || "",
      lastName: contact.LastName || "Unknown",
      phone: contact.Phone || contact.HomePhone || null,
      tags: finalTags,
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

  console.log("✅ XO Marketing tag cleanup/writeback complete");

  return res.status(200).json({
    success: true,
    message: isManualSend
      ? "Contact manually sent to XO Marketing with tag cleanup"
      : "Contact synced to XO Marketing with tag cleanup",
    highLevelId: marketingHLId,
    finalTags
  });
}

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
