import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,

  // XO MARKETING
  HL_API_KEY,
  HL_LOCATION_ID,

  // XO HL / XO MARRIAGE SOURCE SYSTEM
  HL_MARRIAGE_API_KEY,
  HL_MARRIAGE_LOCATION_ID
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
  "SF Shopify Buyer",

  "marital-status-single",
  "marital-status-married",
  "marital-status-divorced",
  "marital-status-widowed"
];

const XO_MARKETING_SF_FIELD_ID = "0w8kYzW7XY8L0rRwxEHA";
const XO_HL_SF_FIELD_ID = "OgA23wE1DwCjXitTl41d";

const XO_MARKETING_RELATIONSHIP_STATUS_FIELD_ID =
  "4EExVf8IIFYNbwhXrYve";

const XO_MARKETING_ACCOUNT_CREATION_DATE_FIELD_ID =
  "S2EWSjB4eiOaYunk65p6";

const XO_MARKETING_WEDDING_ANNIVERSARY_FIELD_ID =
  "TzUr1hWzmE1DFvOPgZw1";

app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF Middleware Running");
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
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
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

function cleanValue(value) {
  if (
    value === undefined ||
    value === null ||
    value === "null" ||
    value === ""
  ) {
    return null;
  }

  return value;
}

function formatDateForSalesforce(value) {
  const clean = cleanValue(value);

  if (!clean) return null;

  const parts = clean.split("/");

  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return clean;
}

function escapeSoql(value) {
  return String(value).replace(/'/g, "\\'");
}

async function getXOHLTags(hlContactId) {
  try {
    const response = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
      {
        headers: {
          Authorization: `Bearer ${HL_MARRIAGE_API_KEY}`,
          Version: "2021-04-15",
          "Content-Type": "application/json"
        }
      }
    );

    const tags =
      response.data.contact?.tags ||
      response.data.tags ||
      [];

    const xoHlTagsText = Array.isArray(tags) ? tags.join(", ") : "";

    console.log("🏷 XO HL Tags:", xoHlTagsText);

    return xoHlTagsText;

  } catch (error) {
    console.error(
      "⚠️ Could not pull XO HL tags:",
      error.response?.data || error.message
    );

    return "";
  }
}

async function getLatestPaidInvoiceForContact(contactHlId) {
  try {
    const response = await axios.get(
      "https://services.leadconnectorhq.com/invoices/",
      {
        headers: {
          Authorization: `Bearer ${HL_MARRIAGE_API_KEY}`,
          Version: "2023-02-21",
          "Content-Type": "application/json"
        },
        params: {
          altId: HL_MARRIAGE_LOCATION_ID,
          altType: "location",
          contactId: contactHlId,
          status: "paid",
          limit: 1,
          offset: 0,
          sortField: "issueDate",
          sortOrder: "desc"
        }
      }
    );

    console.log("📄 Paid invoice found from HighLevel");

    const invoices =
      response.data.invoices ||
      response.data.data ||
      response.data.items ||
      response.data.results ||
      [];

    if (!Array.isArray(invoices) || invoices.length === 0) {
      return null;
    }

    return invoices[0];

  } catch (error) {
    console.error(
      "❌ Could not get latest paid invoice:",
      error.response?.data || error.message
    );

    return null;
  }
}

async function writeSalesforceIdBackToXOHL(
  hlContactId,
  salesforceContactId
) {
  await axios.put(
    `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
    {
      customFields: [
        {
          id: XO_HL_SF_FIELD_ID,
          value: salesforceContactId
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

  console.log("✅ Salesforce ID written back to XO HL");
}

// ======================================================
// XO HL ➜ SALESFORCE CONTACT
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 XO HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;

    console.log("📦 HL Payload:", JSON.stringify(hlData, null, 2));

    const hlContactId = hlData.High_Level_ID__c;

    const dndValue = parseDndValue(
      hlData.emailDnd ?? hlData.dnd
    );

    if (!hlContactId) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing HighLevel Contact Id"
      });
    }

    const xoHlTagsText = await getXOHLTags(hlContactId);

    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          q: `
            SELECT Id
            FROM Contact
            WHERE High_Level_ID__c = '${escapeSoql(hlContactId)}'
            LIMIT 1
          `
        }
      }
    );

    if (query.data.records.length > 0) {
      const sfContactId = query.data.records[0].Id;

      const updateBody = {
        XO_HL_Tags__c: xoHlTagsText
      };

      if (dndValue !== null) {
        updateBody.HasOptedOutOfEmail = dndValue;
      }

      await axios.patch(
        `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfContactId}`,
        updateBody,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (dndValue !== null) {
        console.log(`✅ Salesforce Email Opt Out updated to ${dndValue}`);
      }

      console.log("✅ XO HL fields updated in Salesforce");

      await writeSalesforceIdBackToXOHL(
        hlContactId,
        sfContactId
      );

      console.log("⏭ Existing Salesforce Contact found");

      return res.status(200).json({
        success: true
      });
    }

    const newContactBody = {
      FirstName: hlData.FirstName || "",
      LastName: hlData.LastName || "Unknown",
      Email: hlData.Email || null,
      Phone: hlData.Phone || null,
      HomePhone: hlData.HomePhone || null,

      High_Level_ID__c: hlContactId,
      Origin_From_HL_c__c: true,
      XO_HL_Tags__c: xoHlTagsText
    };

    if (dndValue !== null) {
      newContactBody.HasOptedOutOfEmail = dndValue;
    }

    const createResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      newContactBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const newSalesforceContactId = createResponse.data.id;

    console.log("✅ Contact created in Salesforce");

    await writeSalesforceIdBackToXOHL(
      hlContactId,
      newSalesforceContactId
    );

    return res.status(200).json({
      success: true,
      salesforceContactId: newSalesforceContactId
    });

  } catch (error) {
    console.error(
      "❌ HL ➜ SF Error:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// SF ➜ XO MARKETING ONLY
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ XO Marketing received");

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
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const contact = sfContactResponse.data;

    return await sendToMarketingHighLevel(
      contact,
      res,
      false
    );

  } catch (error) {
    console.error(
      "❌ SF ➜ XO Marketing Error:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// MANUAL BUTTON ➜ XO MARKETING
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
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const contact = sfContactResponse.data;

    return await sendToMarketingHighLevel(
      contact,
      res,
      true
    );

  } catch (error) {
    console.error(
      "❌ Manual XO Marketing Error:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// XO HL INVOICE PAID ➜ SALESFORCE OPPORTUNITY
// Pulls real invoice details from HighLevel List Invoices API
// ======================================================
app.post("/invoice-paid", async (req, res) => {
  try {
    console.log("📩 XO HL Invoice Paid ➜ Salesforce received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const payload = req.body;

    console.log(
      "📦 Invoice Paid Payload:",
      JSON.stringify(payload, null, 2)
    );

    const contactHlId = cleanValue(payload.contactDetails?.id);
    const contactEmail = cleanValue(payload.contactDetails?.email);
    const contactName = cleanValue(payload.contactDetails?.name);

    if (!contactHlId && !contactEmail) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing contact id and email"
      });
    }

    let hlInvoice = null;

    if (contactHlId) {
      hlInvoice = await getLatestPaidInvoiceForContact(contactHlId);
    }

    if (!hlInvoice) {
      console.log("⏭ No paid HighLevel invoice found for contact");

      return res.status(200).json({
        skipped: true,
        reason: "No paid HighLevel invoice found for contact"
      });
    }

    const today = new Date().toISOString().substring(0, 10);

    const invoiceId =
      cleanValue(hlInvoice._id) ||
      cleanValue(hlInvoice.id) ||
      `HL-INVOICE-${contactHlId || contactEmail}-${Date.now()}`;

    const invoiceNumber =
      cleanValue(hlInvoice.invoiceNumber) ||
      cleanValue(hlInvoice.number) ||
      invoiceId;

    const status =
      cleanValue(hlInvoice.status) || "paid";

    const amountPaid =
      Number(cleanValue(hlInvoice.amountPaid)) ||
      Number(cleanValue(hlInvoice.total)) ||
      Number(cleanValue(hlInvoice.totalSummary?.subTotal)) ||
      0;

    const invoiceDate =
      cleanValue(hlInvoice.issueDate) ||
      (cleanValue(hlInvoice.createdAt)
        ? cleanValue(hlInvoice.createdAt).substring(0, 10)
        : today);

    const firstItem =
      Array.isArray(hlInvoice.invoiceItems) && hlInvoice.invoiceItems.length > 0
        ? hlInvoice.invoiceItems[0]
        : null;

    const itemName =
      cleanValue(firstItem?.name) ||
      cleanValue(hlInvoice.name) ||
      contactName ||
      invoiceNumber;

    console.log("🧾 Invoice selected:", {
      invoiceId,
      invoiceNumber,
      status,
      amountPaid,
      invoiceDate,
      itemName
    });

    const existingOppQuery = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          q: `
            SELECT Id
            FROM Opportunity
            WHERE XO_HL_Invoice_ID__c = '${escapeSoql(invoiceId)}'
            LIMIT 1
          `
        }
      }
    );

    if (existingOppQuery.data.records.length > 0) {
      console.log("⏭ Opportunity already exists for this invoice");

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "Opportunity already exists"
      });
    }

    let contactQueryText = "";

    if (contactHlId && contactEmail) {
      contactQueryText = `
        SELECT Id, AccountId
        FROM Contact
        WHERE High_Level_ID__c = '${escapeSoql(contactHlId)}'
           OR Email = '${escapeSoql(contactEmail)}'
        LIMIT 1
      `;
    } else if (contactHlId) {
      contactQueryText = `
        SELECT Id, AccountId
        FROM Contact
        WHERE High_Level_ID__c = '${escapeSoql(contactHlId)}'
        LIMIT 1
      `;
    } else if (contactEmail) {
      contactQueryText = `
        SELECT Id, AccountId
        FROM Contact
        WHERE Email = '${escapeSoql(contactEmail)}'
        LIMIT 1
      `;
    }

    const contactQuery = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          q: contactQueryText
        }
      }
    );

    if (contactQuery.data.records.length === 0) {
      console.log("⏭ No matching Salesforce Contact found");

      return res.status(200).json({
        skipped: true,
        reason: "No matching Salesforce Contact found"
      });
    }

    const contact = contactQuery.data.records[0];

    const invoiceUrl =
      `https://link.xoinstitute.com/invoice/${invoiceId}`;

    const opportunityBody = {
      Name: `XO Marriage - ${itemName}`,
      RecordTypeId: "0121I000000RJCSQA4",
      StageName: "Closed Won",
      CloseDate: invoiceDate,
      Amount: amountPaid,

      AccountId: contact.AccountId || null,
      npsp__Primary_Contact__c: contact.Id,

      XO_HL_Invoice_ID__c: invoiceId,
      XO_HL_Invoice_Number__c: invoiceNumber,
      XO_HL_Status__c: status,
      XO_HL_Invoice_Date__c: invoiceDate,
      XO_HL_Invoice_URL__c: invoiceUrl
    };

    const createOppResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Opportunity`,
      opportunityBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Salesforce Opportunity created from XO HL invoice");

    return res.status(200).json({
      success: true,
      opportunityId: createOppResponse.data.id,
      invoiceId,
      invoiceNumber,
      amountPaid,
      itemName
    });

  } catch (error) {
    console.error(
      "❌ Invoice Paid ➜ Salesforce Opportunity Error:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      handled: true,
      error: error.response?.data || error.message
    });
  }
});

// ======================================================
// BUILD SALESFORCE TAGS
// ======================================================
function buildSalesforceTags(contact, isManualSend) {
  const donorSegment =
    contact.HighLevel_Donor_Segments__c || "";

  const shopifySegment =
    contact.Shopify_Segment__c || "";

  let tags = ["HL Via Salesforce"];

  if (isManualSend) {
    tags.push("Manual Send to XO Marketing");
  }

  if (donorSegment.includes("Mid")) {
    tags.push("SF Mid Donor");
  }

  if (donorSegment.includes("Low")) {
    tags.push("SF Low Donor");
  }

  if (donorSegment.includes("Non")) {
    tags.push("SF Non-Donor");
  }

  if (
    donorSegment.includes("High") ||
    donorSegment.includes("Major")
  ) {
    tags.push("SF Major Donor");
  }

  if (contact.VR__c) {
    tags.push("SF Vision Retreat Attendee");
  }

  if (contact.Conferences__c) {
    tags.push("SF Conference Attendee");
  }

  if (
    shopifySegment &&
    shopifySegment !== "No Shopify"
  ) {
    tags.push("SF Shopify Buyer");
  }

  if (contact.Account_Creation_Date__c) {
  tags.push("account-created");
}

if (contact.Relationship_Status__c) {
  tags.push(
    `marital-status-${contact.Relationship_Status__c
      .toLowerCase()
      .replace(/\s+/g, "-")}`
  );
}

  return tags;
}

// ======================================================
// SEND TO XO MARKETING
// ======================================================
async function sendToMarketingHighLevel(
  contact,
  res,
  isManualSend
) {
  if (!contact.Email) {
    return res.status(200).json({
      skipped: true,
      reason: "Missing email"
    });
  }

  const newSalesforceTags =
    buildSalesforceTags(
      contact,
      isManualSend
    );

  console.log(
    "🏷 New Salesforce tags:",
    newSalesforceTags
  );

  const xoHlTags =
    contact.XO_HL_Tags__c
      ? contact.XO_HL_Tags__c
          .split(",")
          .map(tag => tag.trim())
          .filter(Boolean)
      : [];

  console.log(
    "🏷 XO HL Tags from Salesforce:",
    xoHlTags
  );

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

  const marketingHLId =
    marketingResponse.data.contact?.id;

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
        managedTag =>
          managedTag.toLowerCase() ===
          String(tag).toLowerCase()
      )
  );

  const finalTags = [
    ...new Set([
      ...preservedHighLevelTags,
      ...newSalesforceTags,
      ...xoHlTags
    ])
  ];

  console.log(
    "🧹 Preserved HL-only tags:",
    preservedHighLevelTags
  );

  console.log(
    "✅ Final tags after cleanup:",
    finalTags,
  );
console.log("🧪 Marketing field test", {
  relationshipStatus: contact.Relationship_Status__c,
  accountCreationDate: contact.Account_Creation_Date__c,
  weddingAnniversary: contact.Wedding_Anniversary__c
});

await axios.put(
  `https://services.leadconnectorhq.com/contacts/${marketingHLId}`,
  {
    firstName: contact.FirstName || "",
    lastName: contact.LastName || "Unknown",
    phone: contact.Phone || contact.HomePhone || null,
    tags: finalTags,

customFields: [
  {
    id: XO_MARKETING_SF_FIELD_ID,
    value: contact.Id
  },

  {
    key: "contact.relationship_status",
    value: contact.Relationship_Status__c || ""
  },

  {
    key: "contact.account_creation_date",
    value: contact.Account_Creation_Date__c || ""
  },

  {
    key: "contact.wedding_anniversary",
    value: contact.Wedding_Anniversary__c || ""
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

  console.log("✅ XO Marketing sync complete");

  return res.status(200).json({
    success: true,
    highLevelId: marketingHLId,
    finalTags
  });
}

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
