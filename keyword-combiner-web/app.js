const sourceConfig = {
  branches: {
    textareaId: "branches",
    fileInputId: "branchFile",
    fileNameId: "branchFileName",
    badgeId: "branchBadge",
    heroCountId: "branchCount",
    label: "지점",
  },
  procedures: {
    textareaId: "procedures",
    fileInputId: "procedureFile",
    fileNameId: "procedureFileName",
    badgeId: "procedureBadge",
    heroCountId: "procedureCount",
    label: "시술",
  },
  keywords: {
    textareaId: "keywords",
    fileInputId: "keywordFile",
    fileNameId: "keywordFileName",
    badgeId: "keywordBadge",
    heroCountId: "keywordCount",
    label: "키워드",
  },
};

const previewLimit = 500;

const state = {
  branches: [],
  procedures: [],
  keywords: [],
  xlsxReady: false,
};

document.addEventListener("DOMContentLoaded", () => {
  state.xlsxReady = Boolean(window.XLSX);
  bindTextareas();
  bindFileInputs();
  bindButtons();
  updateAll();
  updateSpreadsheetUi();
});

function bindTextareas() {
  Object.values(sourceConfig).forEach((config) => {
    const textarea = document.getElementById(config.textareaId);
    textarea.addEventListener("input", () => {
      updateStateFromTextarea(config);
      updateAll();
    });
  });
}

function bindFileInputs() {
  Object.entries(sourceConfig).forEach(([key, config]) => {
    const input = document.getElementById(config.fileInputId);

    input.addEventListener("change", async (event) => {
      const [file] = event.target.files || [];
      if (!file) {
        updateFileName(config, "선택한 파일 없음");
        return;
      }

      updateFileName(config, file.name);

      try {
        const values = await readValuesFromFile(file);
        const textarea = document.getElementById(config.textareaId);
        textarea.value = values.join("\n");
        state[key] = values;
        updateAll();
        setStatus(`${config.label} 파일에서 ${values.length.toLocaleString("ko-KR")}개를 불러왔어요.`);
      } catch (error) {
        console.error(error);
        setStatus(`${config.label} 파일을 읽는 중 문제가 생겼어요: ${error.message}`, true);
      } finally {
        input.value = "";
      }
    });
  });
}

function bindButtons() {
  document.getElementById("fillSampleButton").addEventListener("click", fillSampleData);
  document.getElementById("clearButton").addEventListener("click", clearAll);
  document.getElementById("downloadXlsxButton").addEventListener("click", downloadXlsx);
  document.getElementById("downloadCsvButton").addEventListener("click", downloadCsv);
}

function fillSampleData() {
  document.getElementById("branches").value = ["강남", "일산", "다산"].join("\n");
  document.getElementById("procedures").value = ["울쎄라", "인모드", "리쥬란"].join("\n");
  document.getElementById("keywords").value = ["효과", "추천", "부작용", "유지기간"].join("\n");

  syncStateFromAllTextareas();
  updateAll();
  setStatus("예시 데이터를 채워 두었어요. 아래 미리보기에서 조합 결과를 먼저 확인해 보세요.");
}

function clearAll() {
  Object.values(sourceConfig).forEach((config) => {
    document.getElementById(config.textareaId).value = "";
    updateFileName(config, "선택한 파일 없음");
  });

  state.branches = [];
  state.procedures = [];
  state.keywords = [];
  updateAll();
  setStatus("입력한 내용을 모두 비웠어요.");
}

function syncStateFromAllTextareas() {
  Object.values(sourceConfig).forEach((config) => {
    updateStateFromTextarea(config);
  });
}

function updateStateFromTextarea(config) {
  const textarea = document.getElementById(config.textareaId);
  const key = getSourceKeyFromTextareaId(config.textareaId);
  state[key] = tokenizeValues(textarea.value);
}

function getSourceKeyFromTextareaId(textareaId) {
  return Object.keys(sourceConfig).find((key) => sourceConfig[key].textareaId === textareaId);
}

function tokenizeValues(rawText) {
  const seen = new Set();
  const values = String(rawText ?? "")
    .replace(/^\uFEFF/, "")
    .split(/[,\n;\t]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase("ko-KR");
    if (seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

async function readValuesFromFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "txt" || extension === "md") {
    const text = await file.text();
    return tokenizeValues(text);
  }

  if (extension === "csv") {
    const text = await file.text();
    return readValuesFromCsv(text);
  }

  if (extension === "xlsx") {
    if (!state.xlsxReady || !window.XLSX) {
      throw new Error("엑셀 기능을 불러오지 못했어요. 새로고침 후 다시 시도하거나 CSV 파일을 사용해 주세요.");
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return [];
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    const firstColumnValues = [];

    for (let index = 1; index < rows.length; index += 1) {
      const cellValue = rows[index]?.[0];
      if (cellValue !== undefined && cellValue !== null && String(cellValue).trim()) {
        firstColumnValues.push(String(cellValue).trim());
      }
    }

    if (firstColumnValues.length > 0) {
      return dedupeValues(firstColumnValues);
    }

    const fallbackValues = rows
      .flat()
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    return dedupeValues(fallbackValues);
  }

  throw new Error("지원하지 않는 파일 형식이에요. txt, md, csv, xlsx 파일을 사용해 주세요.");
}

function readValuesFromCsv(text) {
  const normalizedText = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rows = normalizedText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);

  if (!rows.length) {
    return [];
  }

  const firstColumnValues = rows
    .slice(1)
    .map((row) => String(row[0] ?? "").trim())
    .filter(Boolean);

  if (firstColumnValues.length > 0) {
    return dedupeValues(firstColumnValues);
  }

  const fallbackValues = rows
    .flat()
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return dedupeValues(fallbackValues);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function dedupeValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase("ko-KR");
    if (seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function updateAll() {
  syncStateFromAllTextareas();
  updateCounts();
  updatePreview();
  updateButtons();
}

function updateCounts() {
  Object.entries(sourceConfig).forEach(([key, config]) => {
    const count = state[key].length;
    document.getElementById(config.badgeId).textContent = `${count.toLocaleString("ko-KR")}개`;
    document.getElementById(config.heroCountId).textContent = count.toLocaleString("ko-KR");
  });

  document.getElementById("totalCount").textContent = getTotalCount().toLocaleString("ko-KR");
}

function getTotalCount() {
  if (!state.branches.length || !state.procedures.length || !state.keywords.length) {
    return 0;
  }

  return state.branches.length * state.procedures.length * state.keywords.length;
}

function buildRows() {
  const rows = [];

  state.branches.forEach((branch) => {
    state.procedures.forEach((procedure) => {
      state.keywords.forEach((keyword) => {
        rows.push([
          branch,
          procedure,
          keyword,
          `${branch} ${procedure} ${keyword}`.trim(),
        ]);
      });
    });
  });

  return rows;
}

function updatePreview() {
  const previewBody = document.getElementById("previewBody");
  const previewMeta = document.getElementById("previewMeta");
  const rows = buildRows();

  if (!rows.length) {
    previewBody.innerHTML = '<tr><td colspan="2" class="empty">먼저 값을 입력해 주세요.</td></tr>';
    previewMeta.textContent = "아직 만들어진 결과가 없어요.";
    return;
  }

  const slicedRows = rows.slice(0, previewLimit);
  previewBody.innerHTML = slicedRows
    .map(
      (row, index) => `
        <tr>
          <td class="col-num">${(index + 1).toLocaleString("ko-KR")}</td>
          <td>${escapeHtml(row[3])}</td>
        </tr>
      `,
    )
    .join("");

  if (rows.length > previewLimit) {
    previewMeta.textContent = `전체 ${rows.length.toLocaleString("ko-KR")}개 중 처음 ${slicedRows.length.toLocaleString("ko-KR")}개를 보여드리고 있어요. 전체는 엑셀 또는 CSV로 저장해서 확인하세요.`;
  } else {
    previewMeta.textContent = `총 ${rows.length.toLocaleString("ko-KR")}개의 조합 키워드입니다.`;
  }
}

function updateButtons() {
  const hasRows = getTotalCount() > 0;
  document.getElementById("downloadXlsxButton").disabled = !hasRows || !state.xlsxReady;
  document.getElementById("downloadCsvButton").disabled = !hasRows;
}

function updateSpreadsheetUi() {
  const xlsxButton = document.getElementById("downloadXlsxButton");

  if (!state.xlsxReady) {
    xlsxButton.title = "엑셀 기능을 불러오지 못해 현재 사용할 수 없습니다.";
    setStatus("엑셀 기능 연결이 불안정해 현재는 TXT·CSV 불러오기와 CSV 저장은 정상 사용 가능합니다. 엑셀 저장이나 XLSX 업로드가 필요하면 새로고침 후 다시 확인해 주세요.", true);
    return;
  }

  xlsxButton.title = "";
}

function updateFileName(config, fileName) {
  const target = document.getElementById(config.fileNameId);
  target.textContent = fileName;
}

function downloadXlsx() {
  const rows = buildRows();
  if (!rows.length) {
    setStatus("저장할 결과가 없어요. 먼저 값을 입력해 주세요.", true);
    return;
  }

  if (!state.xlsxReady || !window.XLSX) {
    setStatus("엑셀 저장 기능을 불러오지 못했어요. CSV 저장을 이용해 주세요.", true);
    return;
  }

  const numberedRows = rows.map((row, i) => [i + 1, ...row]);
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["순번", "지점", "시술", "키워드", "조합 키워드"],
    ...numberedRows,
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "CombinedKeywords");
  XLSX.writeFile(workbook, buildFileName("xlsx"));
  setStatus(`엑셀 파일로 저장했어요. 총 ${rows.length.toLocaleString("ko-KR")}개입니다.`);
}

function downloadCsv() {
  const rows = buildRows();
  if (!rows.length) {
    setStatus("저장할 결과가 없어요. 먼저 값을 입력해 주세요.", true);
    return;
  }

  const numberedRows = rows.map((row, i) => [i + 1, ...row]);
  const csvRows = [["순번", "지점", "시술", "키워드", "조합 키워드"], ...numberedRows];
  const csvContent = csvRows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildFileName("csv");
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`CSV 파일로 저장했어요. 총 ${rows.length.toLocaleString("ko-KR")}개입니다.`);
}

function buildFileName(extension) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `combined-keywords-${timestamp}.${extension}`;
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, isError = false) {
  const statusMessage = document.getElementById("statusMessage");
  statusMessage.textContent = message;
  statusMessage.dataset.tone = isError ? "error" : "default";
}
