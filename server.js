// ======================================================
// XO HL INVOICE PAID ➜ SALESFORCE OPPORTUNITY
// MVP: Creates Opportunity only, no products yet
// Handles missing/null invoice fields from HighLevel
// ======================================================
app.post("/invoice-paid", async (req, res) => {
  try {
    console.log("📩 XO HL Invoice Paid ➜ Salesforce received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const invoice = req.body;

    console.log(
      "📦 Invoice Paid Payload:",
      JSON.stringify(invoice, null, 2)
    );

    const cleanValue = value => {
      if (value === undefined || value === null || value === "null" || value === "") {
        return null;
      }
      return value;
    };

    const today = new Date().toISOString().substring(0, 10);

    const contactHlId = cleanValue(invoice.contactDetails?.id);
    const contactEmail = cleanValue(invoice.contactDetails?.email);

    const invoiceId =
      cleanValue(invoice._id) ||
      cleanValue(invoice.invoiceNumber) ||
      `HL-INVOICE-${contactHlId || contactEmail}-${Date.now()}`;

    const invoiceNumber =
      cleanValue(invoice.invoiceNumber) || invoiceId;

    const status =
      cleanValue(invoice.status) || "paid";

    const amountPaid =
      Number(cleanValue(invoice.amountPaid)) ||
      Number(cleanValue(invoice.total)) ||
      0;

    const invoiceDate =
      cleanValue(invoice.issueDate) ||
      (cleanValue(invoice.createdAt) ? invoice.createdAt.substring(0, 10) : today);

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
            WHERE XO_HL_Invoice_ID__c = '${invoiceId}'
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
        WHERE High_Level_ID__c = '${contactHlId}'
           OR Email = '${contactEmail}'
        LIMIT 1
      `;
    } else if (contactHlId) {
      contactQueryText = `
        SELECT Id, AccountId
        FROM Contact
        WHERE High_Level_ID__c = '${contactHlId}'
        LIMIT 1
      `;
    } else if (contactEmail) {
      contactQueryText = `
        SELECT Id, AccountId
        FROM Contact
        WHERE Email = '${contactEmail}'
        LIMIT 1
      `;
    }

    if (!contactQueryText) {
      return res.status(200).json({
        skipped: true,
        reason: "Missing contact id and email"
      });
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

    const opportunityBody = {
      Name: `HL Invoice - ${invoiceNumber}`,
      RecordTypeId: "0121I000000RJCSQA4",
      StageName: "Closed Won",
      CloseDate: invoiceDate,
      Amount: amountPaid,

      AccountId: contact.AccountId || null,
      npsp__Primary_Contact__c: contact.Id,

      XO_HL_Invoice_ID__c: invoiceId,
      XO_HL_Invoice_Number__c: invoiceNumber,
      XO_HL_Status__c: status,
      XO_HL_Invoice_Date__c: invoiceDate
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
      opportunityId: createOppResponse.data.id
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
