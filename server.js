// ======================================================
// SF ➜ BOTH XO LOCATIONS
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ Both HL Locations received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    if (!sfData.Email) {
      return res.status(200).json({ skipped: true });
    }

    // Get full Salesforce contact
    const sfContactResponse = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfData.Id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const contact = sfContactResponse.data;

    async function pushToHL(apiKey, locationId, sfFieldId, locationLabel) {
      console.log(`📤 Sending to ${locationLabel}`);

      // 1️⃣ UPSERT
      const upsert = await axios.post(
        "https://services.leadconnectorhq.com/contacts/upsert",
        {
          locationId: locationId,
          email: contact.Email,
          firstName: contact.FirstName || "",
          lastName: contact.LastName || "Unknown",
          phone: contact.Phone || contact.HomePhone || null
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      const hlContactId = upsert.data.contact?.id;
      console.log(`✅ ${locationLabel} HL Contact ID:`, hlContactId);

      if (!hlContactId) return null;

      // 2️⃣ WRITE SF ID INTO HL
      await axios.put(
        `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
        {
          customFields: [
            {
              id: sfFieldId,
              value: contact.Id
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      console.log(`✅ Salesforce ID written to ${locationLabel}`);

      return hlContactId;
    }

    // 🔹 PUSH TO MARKETING
    const marketingHLId = await pushToHL(
      process.env.HL_MARKETING_API_KEY,
      process.env.HL_MARKETING_LOCATION_ID,
      "0w8kYzW7XY8L0rRwxEHA", // Marketing SF ID field
      "XO Marketing"
    );

    // 🔹 PUSH TO MARRIAGE
    const marriageHLId = await pushToHL(
      process.env.HL_MARRIAGE_API_KEY,
      process.env.HL_MARRIAGE_LOCATION_ID,
      "OgA23wE1DwCjXitTl41d", // Marriage SF ID field
      "XO Marriage"
    );

    // 3️⃣ WRITE BOTH HL IDS BACK TO SALESFORCE
    await axios.patch(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${contact.Id}`,
      {
        XO_Marketing_High_Level_ID__c: marketingHLId,
        XO_Marriage_High_Level_ID__c: marriageHLId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Both HL IDs written back to Salesforce");

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ Both HL Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});
