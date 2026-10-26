import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESCRIPTION } from "../core/cell.ts";
import { createKernel, runKernel } from "./helpers.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ipython-headstart-")));
const kernel = createKernel();
const at = (name) => JSON.stringify(join(root, name));

const run = async (code) => {
	const { result } = await runKernel(kernel, code, root);
	assert.equal(result.status, "ok", `${code}\n${result.output}`);

	return result.output.trim();
};

const fails = async (code) => {
	const { result } = await runKernel(kernel, code, root);
	assert.equal(result.status, "error", code);

	return result.error;
};

try {
	await run(
		"import json\nimport pandas as pd\nimport openpyxl\nfrom headstart import charge, sauve, montre, combien, compare",
	);

	// hs: dir(hs) lists exactly the verbs of the card in the tool description, and each one is callable.
	const card = [...DESCRIPTION.matchAll(/^hs\.(\w+)\(/gm)].map((match) => match[1]).sort();
	assert.equal(card.length, 9);
	const verbs = await run("print(json.dumps([sorted(dir(hs)), all(callable(getattr(hs, name)) for name in dir(hs))]))");
	assert.deepEqual(JSON.parse(verbs), [card, true]);

	// charge: a jsonl file skips lines that do not parse or are not objects, and reports the count.
	await run(`open(${at("rows.jsonl")}, "w").write('{"a": 1}\\nnot json\\nnull\\n\\n{"a": 2}\\n')`);
	const jsonl = await run(`rows = charge(${at("rows.jsonl")})\nprint(type(rows).__name__, rows["a"].tolist())`);
	assert.match(jsonl, /skipped 2 bad line/);
	assert.match(jsonl, /DataFrame \[1, 2\]$/);

	// charge: xlsx keeps leading-zero codes as text, keeps int columns, and names the other sheets.
	await run(
		[
			`with pd.ExcelWriter(${at("book.xlsx")}, engine="openpyxl") as writer:`,
			`    pd.DataFrame({"code": ["00042", "0012345678905"], "qty": [3, 4]}).to_excel(writer, sheet_name="A", index=False)`,
			`    pd.DataFrame({"name": ["b"]}).to_excel(writer, sheet_name="B", index=False)`,
		].join("\n"),
	);

	const sheetA = await run(
		`book = charge(${at("book.xlsx")})\nprint(json.dumps([book["code"].tolist(), str(book["qty"].dtype)]))`,
	);

	assert.match(sheetA, /other sheets: B/);
	assert.deepEqual(JSON.parse(sheetA.split("\n").at(-1)), [["00042", "0012345678905"], "int64"]);
	const sheetB = await run(`print(charge(${at("book.xlsx")}, sheet="B")["name"].tolist())`);
	assert.match(sheetB, /other sheets: A/);
	assert.match(sheetB, /\['b'\]$/);

	// charge: csv keeps leading-zero codes as text and plain numbers numeric.
	await run(`open(${at("plain.csv")}, "w").write("code,qty,ratio\\n00042,1,0\\n7,2,0.5\\n")`);

	const csv = await run(
		`frame = charge(${at("plain.csv")})\nprint(json.dumps([frame["code"].tolist(), pd.api.types.is_numeric_dtype(frame["qty"]), pd.api.types.is_numeric_dtype(frame["ratio"])]))`,
	);

	assert.deepEqual(JSON.parse(csv), [["00042", "7"], true, true]);

	// charge: json records give a DataFrame, toml gives a dict, and records give a DataFrame.
	await run(`open(${at("records.json")}, "w").write('[{"a": 1}, {"a": 2}]')`);
	await run(`open(${at("config.toml")}, "w").write('name = "x"\\n[section]\\nvalue = 3\\n')`);

	const loaded = await run(
		[
			`records = charge(${at("records.json")})`,
			`config = charge(${at("config.toml")})`,
			`listed = charge([{"a": 1}, {"a": 2}])`,
			`print(json.dumps([type(records).__name__, records["a"].tolist(), config, type(listed).__name__, listed["a"].tolist()]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(loaded), [
		"DataFrame",
		[1, 2],
		{ name: "x", section: { value: 3 } },
		"DataFrame",
		[1, 2],
	]);

	// charge: only a workbook takes a sheet.
	assert.match((await fails(`charge(${at("records.json")}, sheet="A")`)).evalue, /sheet only for/);

	// sauve: text and unsupported suffixes fail before any write, and point to Pi's write tool.
	await fails(`sauve(${at("text.json")}, "hello")`);
	await fails(`sauve(${at("text.parquet")}, "hello")`);

	for (const name of ["notes.txt", "saved.toml"]) {
		const error = await fails(`sauve(${at(name)}, {"a": 1})`);
		assert.match(error.evalue, /write/);
		assert.equal(await run(`import os\nprint(os.path.exists(${at(name)}))`), "False");
	}

	// sauve: csv, jsonl, xlsx and parquet need a DataFrame or records, and fail before any write.
	for (const name of ["mapping.csv", "mapping.jsonl", "mapping.xlsx", "mapping.parquet"]) {
		const error = await fails(`sauve(${at(name)}, {"a": [1]})`);
		assert.equal(error.ename, "TypeError");
		assert.equal(await run(`import os\nprint(os.path.exists(${at(name)}))`), "False");
	}

	// sauve: a plain list stays a plain value in json, and an empty frame gets a sheet.
	const plain = await run(
		[
			`sauve(${at("plain.json")}, [1, 2, 3])`,
			`sauve(${at("empty.xlsx")}, pd.DataFrame({"x": []}))`,
			`print(json.dumps([charge(${at("plain.json")}), openpyxl.load_workbook(${at("empty.xlsx")}).sheetnames]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(plain), [[1, 2, 3], ["Sheet1"]]);

	// sauve: xlsx has a frozen header, a filter on the header, sized columns, one sheet per key, and no index.
	await run(
		[
			`wide = pd.DataFrame({"identifier": ["a" * 30, "b"], "n": [1, 2]})`,
			`sauve(${at("out.xlsx")}, {"First": wide, "Second": pd.DataFrame({"x": [1]})})`,
			`sauve(${at("single.xlsx")}, wide)`,
		].join("\n"),
	);

	const xlsx = await run(
		[
			`saved = openpyxl.load_workbook(${at("out.xlsx")})`,
			`ws = saved["First"]`,
			`single = openpyxl.load_workbook(${at("single.xlsx")})`,
			`print(json.dumps([saved.sheetnames, ws.freeze_panes, ws.auto_filter.ref, [ws.column_dimensions[c].width for c in "AB"], [cell.value for cell in ws[1]], single.sheetnames]))`,
		].join("\n"),
	);

	const [sheetnames, frozen, filter, widths, header, single] = JSON.parse(xlsx);
	assert.deepEqual(sheetnames, ["First", "Second"]);
	assert.equal(frozen, "A2");
	assert.match(filter, /^A1:B\d+$/);

	for (const width of widths) assert.notEqual(width, 13);
	assert.deepEqual(header, ["identifier", "n"]);
	assert.deepEqual(single, ["Sheet1"]);

	// sauve: csv has no index column, and json and jsonl round-trip through charge.
	const roundTrip = await run(
		[
			`table = pd.DataFrame({"name": ["a", "b"], "n": [1, 2]})`,
			`sauve(${at("out.csv")}, table)`,
			`sauve(${at("out.json")}, table)`,
			`sauve(${at("out.jsonl")}, table.to_dict("records"))`,
			`print(json.dumps([open(${at("out.csv")}).readline().strip(), charge(${at("out.json")}).equals(table), charge(${at("out.jsonl")}).equals(table)]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(roundTrip), ["name,n", true, true]);

	// sauve: parquet has no index column and keeps mixed types through charge.
	const parquet = await run(
		[
			"import pyarrow.parquet",
			`mixed = pd.DataFrame({"name": ["a", None, "c"], "n": [1, 2, 3], "x": [1.5, float("nan"), 3.0], "ok": [True, False, True], "when": pd.to_datetime(["2024-01-01", "2024-02-01", "2024-03-01"])})`,
			`sauve(${at("out.parquet")}, mixed.iloc[::-1])`,
			`print(json.dumps([pyarrow.parquet.read_schema(${at("out.parquet")}).names == list(mixed.columns), charge(${at("out.parquet")}).equals(mixed.iloc[::-1].reset_index(drop=True))]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(parquet), [true, true]);
	// montre: returns the same object it receives.
	const same = await run(`df = pd.DataFrame({"row": [f"row-{i}" for i in range(1000)]})\nprint(montre(df) is df)`);
	assert.equal(same.split("\n").at(-1), "True");

	// montre: a long frame shows its first and last rows and a marker, not the middle.
	const frame = await run(`_ = montre(df)`);
	assert.match(frame, /row-0\b/);
	assert.match(frame, /row-999\b/);
	assert.doesNotMatch(frame, /row-500\b/);
	assert.match(frame, /\[960 of 1,000 rows hidden\]/);

	// montre: long text keeps its head and tail and marks the cut.
	const text = await run(`_ = montre("HEAD" + "." * 10000 + "TAIL", n=2)`);
	assert.match(text, /^HEAD/);
	assert.match(text, /TAIL$/);
	assert.match(text, /characters hidden/);

	// montre: as the last line of a cell, the view is shown once; the next cell shows its value as usual.
	const { result: once } = await runKernel(kernel, "montre(df)", root);
	assert.equal(once.status, "ok");
	assert.equal(once.output.match(/rows hidden/g)?.length, 1);
	assert.equal(once.output.match(/row-999\b/g)?.length, 1);
	assert.match(await run(`{"plain": 1}`), /\{'plain': 1\}/);

	// combien: NaN counts as a value, rows come by count, with n and share; two keys and records work.
	const counts = await run(
		[
			`people = pd.DataFrame({"city": [None, None, None, "Lyon", "Lyon", "Nice"], "kind": ["a", "a", "b", "a", "a", "a"]})`,
			`one = combien(people, "city")`,
			`two = combien(people, "city", "kind")`,
			`print(json.dumps([one["city"].isna().tolist(), one["n"].tolist(), one["share"].round(3).tolist(), two["n"].tolist(), combien(people.to_dict("records"), "city", "kind").equals(two)]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(counts), [[true, false, false], [3, 2, 1], [0.5, 0.333, 0.167], [2, 2, 1, 1], true]);

	// combien: needs at least one key.
	assert.equal((await fails(`combien(people)`)).ename, "TypeError");

	// compare: rows only in a, only in b, or changed; equal rows and NaN against NaN give no row.
	const diff = await run(
		[
			`left = pd.DataFrame({"id": [1, 2, 3, 4], "v": [1.0, 2.0, float("nan"), 4.0]})`,
			`right = pd.DataFrame({"id": [2, 3, 4, 5], "v": [2.0, float("nan"), 9.0, 5.0]})`,
			`found = compare(left, right, "id")`,
			`print(json.dumps([found.columns.tolist(), found["id"].tolist(), found["state"].tolist()]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(diff), [
		["id", "state", "v_a", "v_b"],
		[1, 4, 5],
		["only a", "changed", "only b"],
	]);

	// compare: a nullable NA against a value is a changed row.
	const nullable = await run(
		[
			`na_left = pd.DataFrame({"id": [1, 2, 3], "v": pd.array([1, None, None], dtype="Int64")})`,
			`na_right = pd.DataFrame({"id": [1, 2, 3], "v": pd.array([1, 5, None], dtype="Int64")})`,
			`found = compare(na_left, na_right, "id")`,
			`print(json.dumps([found["id"].tolist(), found["state"].tolist()]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(nullable), [[2], ["changed"]]);

	// joins: prints matched, only a and only b rows, takes records, and adds no _merge column.
	const joined = await run(
		[
			`ja = [{"id": 1, "x": "a"}, {"id": 2, "x": "b"}, {"id": 3, "x": "c"}, {"id": 4, "x": "d"}]`,
			`jb = [{"id": 2, "y": 20}, {"id": 3, "y": 30}, {"id": 5, "y": 50}]`,
			`found = hs.joins(ja, jb, "id")`,
			`print(json.dumps([len(found), found.columns.tolist()]))`,
		].join("\n"),
	);

	assert.match(joined, /^matched 2, only a 2, only b 1$/m);
	assert.deepEqual(JSON.parse(joined.split("\n").at(-1)), [4, ["id", "x", "y"]]);

	// joins: a key that repeats in b refuses a left or inner join with more rows than a, and names only the repeated key of a.
	await run(
		`left = pd.DataFrame({"id": [1, 2, 3]})\nright = pd.DataFrame({"id": [2, 2, 2, 2, 4], "y": [1, 2, 3, 4, 5]})`,
	);

	for (const how of ["", `, how="inner"`]) {
		const refused = await fails(`hs.joins(left, right, "id"${how})`);
		assert.equal(refused.ename, "ValueError");
		assert.match(refused.evalue, /1 keys repeat in b, such as \[2\];/);
	}

	// joins: validate= returns the merge, and m:m turns the guard off.
	const sizes = await run(
		`print(len(hs.joins(left, right.drop_duplicates("id"), "id", validate="m:1")), len(hs.joins(left, right, "id", validate="m:m")))`,
	);

	assert.equal(sizes.split("\n").at(-1), "3 6");

	// decris: one row per column; a mixed column has no min or max, an array column has no distinct, top, min or max, a category column with an unused category leaves it out of top, and records give the same profile.
	const profile = await run(
		[
			"import numpy as np",
			`frame = pd.DataFrame({"n": [1.0, None, 3.0, 3.0], "t": ["a", "b", None, "a"], "m": [1, "x", None, 2], "r": [np.array([1, 2]), np.array([3, 4]), None, np.array([1, 2])]})`,
			`p = hs.decris(frame)`,
			`q = p.astype(object).where(p.notna(), None)`,
			`print(json.dumps([p["missing"].round(3).tolist(), q["distinct"].tolist(), q["top"].tolist(), q["min"].tolist(), q["max"].tolist(), bool(p.equals(hs.decris(frame.to_dict("records"))))]))`,
			`c = hs.decris(pd.DataFrame({"c": pd.Categorical(["a", None, "a", "b"], categories=["a", "b", "z"])}))`,
			`print(json.dumps([c["distinct"].tolist(), c["top"].tolist()]))`,
		].join("\n"),
	);

	assert.deepEqual(JSON.parse(profile.split("\n").at(-2)), [
		[0.25, 0.25, 0.25, 0.25],
		[2, 2, 3, null],
		[[3, 1], ["a", "b"], [1, "x", 2], null],
		[1, "a", null, null],
		[3, "b", null, null],
		true,
	]);
	assert.deepEqual(JSON.parse(profile.split("\n").at(-1)), [[2], [["a", "b"]]]);

	// verifie: all true checks print one line each and return None.
	assert.equal(await run(`print(hs.verifie({"a": True, "b": 1 == 1}))`), "passed a\npassed b\nNone");

	// verifie: every check runs before one error names all the failed checks.
	const { result: checked } = await runKernel(kernel, `hs.verifie({"a": True, "b": False, "c": 1 > 2})`, root);
	assert.equal(checked.status, "error");
	assert.equal(checked.error.ename, "AssertionError");
	assert.match(checked.error.evalue, /failed: b, c$/);
	assert.match(checked.output, /^passed a$/m);
	assert.match(checked.output, /^failed b$/m);
	assert.match(checked.output, /^failed c$/m);

	// verifie: a check that is not one True or False fails before any check runs.
	const { result: series } = await runKernel(kernel, `hs.verifie({"a": True, "s": pd.Series([True, False])})`, root);
	assert.equal(series.error.ename, "TypeError");
	assert.match(series.error.evalue, /not Series for 's': use \.all\(\)$/);
	assert.doesNotMatch(series.output, /passed a/);

	// interroge: a fake BigQuery client records each query; this block stays last because the patch remains in the kernel.
	await run(
		[
			"import os",
			"from google.cloud import bigquery",
			"class FakeJob:",
			"    def __init__(self, client):",
			"        self.client = client",
			"        self.statement_type = client.kind",
			"        self.total_bytes_processed = client.estimate",
			"    def to_dataframe(self, **kwargs):",
			"        if self.client.interrupt:",
			"            raise KeyboardInterrupt",
			"        return pd.DataFrame({'x': [1, 2]})",
			"    def cancel(self):",
			"        FakeClient.calls.append('cancel')",
			"class FakeClient:",
			"    calls = []",
			"    kind = 'SCRIPT'",
			"    estimate = 1_234_567_890",
			"    interrupt = False",
			"    def __init__(self, project):",
			"        FakeClient.calls.append(('project', project))",
			"    def query(self, sql, job_config):",
			"        FakeClient.calls.append((job_config.dry_run, job_config.use_query_cache, job_config.maximum_bytes_billed))",
			"        return FakeJob(self)",
			"bigquery.Client = FakeClient",
		].join("\n"),
	);

	// interroge: a missing environment fails before any client exists.
	await run(`os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)\nos.environ.pop("CLOUDSDK_CORE_PROJECT", None)`);
	assert.equal((await fails(`hs.interroge("select 1")`)).ename, "RuntimeError");
	assert.equal(await run("print(FakeClient.calls)"), "[]");

	// interroge: with no cap, it prints the type and the estimate, returns None and runs only the dry run.
	await run(
		`os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/key.json"\nos.environ["CLOUDSDK_CORE_PROJECT"] = "demo-project"`,
	);
	assert.equal(await run(`result = hs.interroge("select 1")`), "SCRIPT, 1.2 GB");
	assert.equal(
		await run("print(result is None, FakeClient.calls)"),
		"True [('project', 'demo-project'), (True, False, None)]",
	);

	// interroge: an estimate above the cap is refused with the type and the estimate, and nothing runs.
	await run("FakeClient.calls.clear()\nFakeClient.estimate = 25_000_000_000");
	const above = await fails(`hs.interroge("select 1", cap="20 GB")`);
	assert.equal(above.ename, "ValueError");
	assert.match(above.evalue, /SCRIPT, 25,000,000,000 bytes/);
	assert.equal(await run("print(FakeClient.calls)"), "[('project', 'demo-project'), (True, False, None)]");

	// interroge: within the cap, the dry run comes first, then the run billed at most the cap.
	await run("FakeClient.calls.clear()\nFakeClient.estimate = 1_000");
	assert.equal(
		await run(`print(hs.interroge("select 1", cap="4.1 GB")["x"].tolist(), FakeClient.calls)`),
		"[1, 2] [('project', 'demo-project'), (True, False, None), (None, None, 4100000000)]",
	);

	// interroge: an interrupt during the download cancels the job and raises again.
	await run("FakeClient.calls.clear()\nFakeClient.interrupt = True");
	assert.equal((await fails(`hs.interroge("select 1", cap=10_000)`)).ename, "KeyboardInterrupt");
	assert.equal(await run("print(FakeClient.calls[-1])"), "cancel");
} finally {
	await kernel.shutdown();
	rmSync(root, { recursive: true, force: true });
}

console.log("headstart: charge, sauve, montre, combien, compare, joins, decris, verifie and interroge passed");
