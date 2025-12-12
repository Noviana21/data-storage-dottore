const express = require("express");
const multer = require("multer");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

// const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const upload = multer();

// KONFIGURASI MINIO
const s3 = new S3Client({
    // endpoint: "http://localhost:9000",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
        accessKeyId: "admin",
        secretAccessKey: "password123",
    },
});

const BUCKET = "dottore";
const METADATA_FILE = "metadata.json";

// METADATA HANDLER
function loadMeta() {
    if (!fs.existsSync(METADATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(METADATA_FILE));
}

function saveMeta(data) {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
}

// OBJECT CHECKER
async function existsInMinio(key) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
            return true;
        } catch (err) {
            // kalau object hilang, MinIO balikin 404 / NotFound / NoSuchKey
            const code = err?.name || err?.Code || err?.code;
            const status = err?.$metadata?.httpStatusCode;
            if (status === 404 || code === "NotFound" || code === "NoSuchKey") return false;
            throw err; // error lain biar kelihatan
        }
    }

// SETUP EXPRESS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

// ROUTES

// UPLOAD
// app.get("/", (req, res) => res.redirect("/upload"));
app.get("/", (req, res) => res.redirect("/upload"));

app.get("/upload", (req, res) => {
    res.render("upload", {
        success: req.query.success || "",
        error: req.query.error || "",
    });
});


app.post("/upload", upload.single("file"), async (req, res) => {
    const file = req.file;
    const { title, description } = req.body;

    if (!file || !title) return res.send("File dan judul harus diisi.");

    const words = (description || "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return res.send("Desc harus diisi.");
    if (words.length > 50) return res.send("Desc maksimal 50 kata.");
    const limitedDesc = words.join(" ");

    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const objectKey = `images/${timestamp}${ext}`;

    const tagValue = limitedDesc.slice(0, 50);
    const tagging = tagValue ? `desc=${encodeURIComponent(tagValue)}` : "";

    try {
        await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: objectKey,
            Body: file.buffer,
            ContentType: file.mimetype,

            Metadata: {
            title: title,
            description: limitedDesc,
            },

            ...(tagging ? { Tagging: tagging } : {}),
        })
        );

        const metadata = loadMeta();
        metadata.push({
        id: timestamp,
        filename: file.originalname,
        object_key: objectKey,
        title,
        description: limitedDesc,
        tags: [],
        uploaded_at: new Date().toISOString(),
        });
        saveMeta(metadata);

        res.redirect("/upload?success=" + encodeURIComponent("Upload success!"));
    } catch (err) {
        console.error(err);
        res.redirect("/upload?error=" + encodeURIComponent("Mission failed!"));
    }
});

// LIST
app.get("/photos", async (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    let metadata = loadMeta();

    const keep = [];
    for (const item of metadata) {
        const ok = await existsInMinio(item.object_key);
        console.log(item.object_key, ok ? "EXISTS" : "MISSING");
        if (ok) keep.push(item);
    }

    if (keep.length !== metadata.length) {
        saveMeta(keep);
    }

    const filtered = keep.filter((item) => {
        return (
        (item.title || "").toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q)
        );
    });

    res.render("list", { photos: filtered, query: req.query.q || "" });
});

app.get("/image", async (req, res) => {
    try {
        const key = req.query.key;
        if (!key) return res.status(400).send("Missing key");

        const result = await s3.send(
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
        })
        );

        if (result.ContentType) res.setHeader("Content-Type", result.ContentType);

        res.setHeader("Cache-Control", "public, max-age=3600");

        result.Body.pipe(res);
    } catch (err) {
        console.error("IMAGE PROXY ERROR:", err);
        res.status(404).send("Image not found");
    }
});

// SERVER START
console.log(">>> Using bucket:", BUCKET);
app.listen(3000, () => console.log("Server running on http://localhost:3000"));