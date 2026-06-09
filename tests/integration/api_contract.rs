use super::support;
use axum::http::header;
use axum_test::TestServer;
use dcmview::annotations::{AnnotationStore, EmbedRoiAnnotations};
use dcmview::server;
use dcmview::types::WindowPreset;
use serde_json::Value;
use std::collections::HashMap;
use tempfile::tempdir;

#[tokio::test]
async fn json_endpoints_match_frontend_contract_shapes() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("contract.dcm");
    support::write_uncompressed_u16_dicom(
        &path,
        "1.2.840.10008.1.2.1",
        2,
        2,
        vec![0, 1000, 2000, 3000],
        Some("1500"),
        Some("3000"),
    );

    let mut entry = support::file_entry(path, "1.2.840.10008.1.2.1", 1);
    entry.rows = 2;
    entry.columns = 2;
    entry.default_window = Some(WindowPreset {
        center: 1500.0,
        width: 3000.0,
    });

    let mut state = support::app_state(vec![entry]);
    state.annotations = AnnotationStore::new(HashMap::from([(
        0,
        EmbedRoiAnnotations {
            num_roi: 1,
            roi_coords: vec![[1, 2, 3, 4]],
            roi_frames: vec![vec![0]],
        },
    )]));

    let test_server = TestServer::new(server::router(state));

    let files: Value = test_server.get("/api/files").await.json();
    assert_object_keys(
        &files,
        &["files", "server_start_ms", "tunnel_host", "tunnelled"],
    );
    let file = &files["files"].as_array().expect("files array")[0];
    assert_object_keys(
        file,
        &[
            "columns",
            "default_window",
            "frame_count",
            "has_pixels",
            "index",
            "instance_number",
            "label",
            "modality",
            "path",
            "patient_id",
            "patient_name",
            "rows",
            "series_description",
            "series_instance_uid",
            "series_number",
            "sop_instance_uid",
            "study_date",
            "study_description",
            "study_instance_uid",
            "transfer_syntax_uid",
        ],
    );
    assert_object_keys(&file["default_window"], &["center", "width"]);

    let info: Value = test_server.get("/api/file/0/info").await.json();
    assert_object_keys(
        &info,
        &[
            "columns",
            "default_window",
            "frame_count",
            "has_pixels",
            "rows",
            "transfer_syntax",
        ],
    );
    assert_object_keys(&info["default_window"], &["center", "width"]);

    let tags: Value = test_server.get("/api/file/0/tags").await.json();
    let tag_rows = tags.as_array().expect("tag response array");
    let rows_tag = tag_rows
        .iter()
        .find(|row| row["keyword"] == "Rows")
        .expect("Rows tag");
    assert_tag_node_shape(rows_tag);
    assert_object_keys(&rows_tag["value"], &["type", "value"]);
    assert_eq!(rows_tag["value"]["type"], "number");

    let pixel_data_tag = tag_rows
        .iter()
        .find(|row| row["tag"] == "(7FE0,0010)")
        .expect("PixelData tag");
    assert_tag_node_shape(pixel_data_tag);
    assert_object_keys(&pixel_data_tag["value"], &["length", "type"]);
    assert_eq!(pixel_data_tag["value"]["type"], "binary");

    let annotations: Value = test_server.get("/api/file/0/annotations").await.json();
    assert_object_keys(&annotations, &["num_roi", "roi_coords", "roi_frames"]);
    assert_eq!(
        annotations["roi_coords"][0],
        serde_json::json!([1, 2, 3, 4])
    );
    assert_eq!(annotations["roi_frames"][0], serde_json::json!([0]));

    let missing = test_server.get("/api/file/99/info").await;
    missing.assert_status_not_found();
    let error: Value = missing.json();
    assert_object_keys(&error, &["error"]);
    assert_eq!(error["error"], "file index out of range");
}

#[tokio::test]
async fn raw_frame_endpoint_exposes_frontend_metadata_header_contract() {
    let dir = tempdir().expect("temp dir");
    let path = dir.path().join("raw-contract.dcm");
    support::write_uncompressed_u16_dicom(
        &path,
        "1.2.840.10008.1.2.1",
        2,
        2,
        vec![0, 1000, 2000, 3000],
        Some("1500"),
        Some("3000"),
    );

    let mut entry = support::file_entry(path, "1.2.840.10008.1.2.1", 1);
    entry.rows = 2;
    entry.columns = 2;
    entry.default_window = Some(WindowPreset {
        center: 1500.0,
        width: 3000.0,
    });

    let test_server = TestServer::new(server::router(support::app_state(vec![entry])));
    let response = test_server.get("/api/file/0/frame/0/raw").await;
    response.assert_status_ok();

    assert_eq!(
        response
            .header(header::CONTENT_TYPE)
            .to_str()
            .expect("content-type"),
        "application/octet-stream"
    );
    for header_name in [
        "X-Cache",
        "X-Frame-Rows",
        "X-Frame-Columns",
        "X-Frame-Bits-Allocated",
        "X-Frame-Pixel-Representation",
        "X-Frame-Samples-Per-Pixel",
        "X-Frame-Photometric-Interpretation",
        "X-Frame-Rescale-Slope",
        "X-Frame-Rescale-Intercept",
        "X-Frame-Default-Wc",
        "X-Frame-Default-Ww",
    ] {
        assert!(
            response.maybe_header(header_name).is_some(),
            "raw response missing {header_name}"
        );
    }
}

fn assert_tag_node_shape(value: &Value) {
    assert_object_keys(value, &["keyword", "tag", "value", "vr"]);
    assert!(value["tag"].as_str().expect("tag string").starts_with('('));
    assert!(value["vr"].is_string());
    assert!(value["keyword"].is_string());
    assert!(value["value"]["type"].is_string());
}

fn assert_object_keys(value: &Value, expected: &[&str]) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("expected object, got {value:?}"));
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();

    let mut expected = expected.to_vec();
    expected.sort_unstable();

    assert_eq!(actual, expected);
}
