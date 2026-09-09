const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex < 0) return;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key && !process.env[key]) process.env[key] = value;
    });
}

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const FIELD_NAME_MAP = {
  submission_id: "测评ID",
  submitted_at: "提交时间",
  source_event: "来源活动",
  source_channel: "来源渠道",
  name: "姓名",
  company: "公司",
  company_short_name: "公司简称",
  role: "职位",
  contact: "联系方式",
  business_type: "公司业务类型",
  user_role: "用户角色",
  company_scale: "公司规模",
  primary_ltc_pain: "最想优先改善的 LTC 环节",
  money_leak_stage: "最明显漏钱的 LTC 环节",
  expert_dependency_stage: "最依赖高手经验的 LTC 环节",
  standardizable_stage: "最适合标准化的 LTC 环节",
  main_problem_text: "最常见销售或交付问题",
  ai_stage: "AI 使用状态",
  has_expert_rules: "高手判断标准化程度",
  knowledge_asset_status: "知识资产状态",
  ai_goal: "AI 优先目标",
  is_high_frequency: "目标环节发生频率",
  risk_level: "目标环节风险水平",
  materials_ready: "目标环节资料准备度",
  target_metric: "30 天目标指标",
  one_action_text: "希望 AI 先接管的动作",
  expert_to_copy_text: "最值得复制经验的人",
  failure_concern_text: "最担心 AI 失败的原因",
  report_title: "报告标题",
  report_summary: "一句话总判断",
  report_primary_leak_stage: "诊断出的最漏 LTC 环节",
  report_ltc_reason: "LTC 漏点判断理由",
  report_ltc_risk_note: "LTC 风险提示",
  report_ai_stage: "诊断出的 AI 落地阶段",
  report_ai_stage_reason: "AI 阶段判断理由",
  report_current_bottleneck: "当前最大瓶颈",
  report_recommended_stage_path: "推荐阶段打法",
  report_stage_path_reason: "推荐阶段打法理由",
  report_why_not_other_1: "暂不优先打法说明1",
  report_why_not_other_2: "暂不优先打法说明2",
  report_first_shot_scene: "第一枪场景",
  report_first_shot_ltc_focus: "第一枪 LTC 聚焦环节",
  report_first_shot_reason: "第一枪判断理由",
  report_week1_action: "第1周动作",
  report_week1_output: "第1周交付物",
  report_week2_action: "第2周动作",
  report_week2_output: "第2周交付物",
  report_week34_action: "第3-4周动作",
  report_week34_output: "第3-4周交付物",
  report_followup_prepare: "复盘前准备",
  report_cta: "CTA 文案",
  full_answers_json: "完整答案 JSON",
  report_json: "完整报告 JSON",
  report_text: "完整报告正文",
  pdf_file_name: "PDF 文件名",
  pdf_attached: "PDF 是否已上传",
  feishu_error: "飞书写入错误",
  followup_status: "跟进状态",
  followup_note: "跟进备注",
};

const app = express();

app.use(cors({
  origin(origin, callback) {
    if (ALLOWED_ORIGIN === "*" || !origin || origin === ALLOWED_ORIGIN) {
      callback(null, true);
      return;
    }
    callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "t20-ai-assessment-api" });
});

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function feishuFetch(apiPath, init = {}) {
  const response = await fetch(`${FEISHU_BASE_URL}${apiPath}`, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Feishu API returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || `Feishu API error ${response.status}`);
  }
  return data;
}

async function getTenantAccessToken() {
  const data = await feishuFetch("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({
      app_id: getRequiredEnv("FEISHU_APP_ID"),
      app_secret: getRequiredEnv("FEISHU_APP_SECRET"),
    }),
  });
  return data.tenant_access_token;
}

async function getExistingFields(token, appToken, tableId) {
  const fields = new Map();
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const data = await feishuFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${query.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    for (const field of data.data?.items || []) {
      if (field.field_name) fields.set(field.field_name, field);
    }
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);
  return fields;
}

function toFeishuFieldName(fieldName) {
  return FIELD_NAME_MAP[fieldName] || fieldName;
}

function coerceFieldValue(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (field.type === 1 && typeof value !== "string") return String(value);
  return value;
}

async function uploadPdfToFeishu(token, pdfBase64, fileName, appToken) {
  const buffer = Buffer.from(pdfBase64, "base64");
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", appToken);
  form.append("size", String(buffer.length));
  form.append("mime", "application/pdf");
  form.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);

  const response = await fetch(`${FEISHU_BASE_URL}/drive/v1/files/upload_all`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || `Upload failed: ${text.slice(0, 200)}`);
  }
  return { fileToken: data.data?.file_token, size: buffer.length };
}

async function attachPdfToRecord(token, appToken, tableId, recordId, attachmentFieldName, fileToken, fileName, fileSize) {
  await feishuFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        [attachmentFieldName]: [{ file_token: fileToken, name: fileName, size: fileSize }],
        "PDF 是否已上传": "是",
      },
    }),
  });
}

async function createRecord(token, appToken, tableId, fields) {
  const result = await feishuFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  return result.data?.record?.record_id || "";
}

async function updateRecord(token, appToken, tableId, recordId, fields) {
  await feishuFetch(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  return recordId;
}

app.post("/api/submit", async (req, res) => {
  try {
    const { fieldValues, pdfBase64, pdfFileName, recordId: existingRecordId } = req.body || {};
    if (!fieldValues || typeof fieldValues !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid payload: fieldValues required" });
    }

    const appToken = getRequiredEnv("FEISHU_APP_TOKEN");
    const tableId = getRequiredEnv("FEISHU_TABLE_ID");
    const token = await getTenantAccessToken();
    const existingFields = await getExistingFields(token, appToken, tableId);

    const filteredFields = {};
    let skippedCount = 0;
    for (const [programFieldName, rawValue] of Object.entries(fieldValues)) {
      const feishuFieldName = toFeishuFieldName(programFieldName);
      const field = existingFields.get(feishuFieldName);
      if (!field) {
        skippedCount += 1;
        continue;
      }
      const value = coerceFieldValue(rawValue, field);
      if (value !== undefined) filteredFields[feishuFieldName] = value;
    }

    if (Object.keys(filteredFields).length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No matching Feishu fields found. Check whether the table headers match the field template.",
      });
    }

    const recordId = existingRecordId
      ? await updateRecord(token, appToken, tableId, existingRecordId, filteredFields)
      : await createRecord(token, appToken, tableId, filteredFields);
    let pdfAttached = false;
    let pdfError = null;

    if (pdfBase64 && pdfFileName && recordId) {
      try {
        const attachmentFieldName = existingFields.has("PDF 文件") ? "PDF 文件" : null;
        if (!attachmentFieldName) {
          pdfError = "No attachment field named PDF 文件 found";
        } else {
          const upload = await uploadPdfToFeishu(token, pdfBase64, pdfFileName, appToken);
          await attachPdfToRecord(token, appToken, tableId, recordId, attachmentFieldName, upload.fileToken, pdfFileName, upload.size);
          pdfAttached = true;
        }
      } catch (error) {
        pdfError = error instanceof Error ? error.message : "PDF attach failed";
      }
    }

    res.json({
      ok: true,
      recordId,
      submittedFieldCount: Object.keys(filteredFields).length,
      skippedFieldCount: skippedCount,
      pdfAttached,
      pdfError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[/api/submit]", message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`T20 assessment API running on port ${PORT}`);
});
