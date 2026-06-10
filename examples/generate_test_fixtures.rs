use dicom_core::value::fragments::Fragments;
use dicom_core::value::PixelFragmentSequence;
use dicom_core::{DataElement, PrimitiveValue, VR};
use dicom_dictionary_std::{tags, uids};
use dicom_object::{meta::FileMetaTableBuilder, InMemDicomObject};
use image::{GrayImage, Luma};
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    fs::create_dir_all(&fixture_dir).expect("create fixture directory");

    write_uncompressed_multiframe(&fixture_dir.join("golden-uncompressed-u16-multiframe.dcm"));
    write_jpeg_single_frame(&fixture_dir.join("golden-jpeg-baseline-single-frame.dcm"));
    write_large_jpeg_single_frame(
        &fixture_dir.join("golden-jpeg-baseline-large-single-frame.dcm"),
    );
    write_jpeg_multiframe_with_bot(&fixture_dir.join("golden-jpeg-baseline-multiframe-bot.dcm"));
    write_sr_without_pixels(&fixture_dir.join("golden-no-pixels-sr.dcm"));
}

fn write_uncompressed_multiframe(path: &Path) {
    let samples: Vec<u16> = vec![
        0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 50,
        150, 250, 350, 450, 550, 650, 750, 850, 950, 1050, 1150, 1250, 1350, 1450, 1550, 1500,
        1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 0,
    ];

    let mut pixel_bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        pixel_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    let mut obj = InMemDicomObject::from_element_iter([
        DataElement::new(tags::SOP_CLASS_UID, VR::UI, uids::CT_IMAGE_STORAGE),
        DataElement::new(tags::SOP_INSTANCE_UID, VR::UI, "2.25.2000001"),
        DataElement::new(
            tags::PATIENT_ID,
            VR::LO,
            PrimitiveValue::from("GOLDEN-UNCOMP"),
        ),
        DataElement::new(tags::MODALITY, VR::CS, PrimitiveValue::from("CT")),
        DataElement::new(tags::STUDY_DATE, VR::DA, PrimitiveValue::from("20260608")),
        DataElement::new(tags::ROWS, VR::US, PrimitiveValue::from(4_u16)),
        DataElement::new(tags::COLUMNS, VR::US, PrimitiveValue::from(4_u16)),
        DataElement::new(tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(16_u16)),
        DataElement::new(tags::BITS_STORED, VR::US, PrimitiveValue::from(16_u16)),
        DataElement::new(tags::HIGH_BIT, VR::US, PrimitiveValue::from(15_u16)),
        DataElement::new(
            tags::PIXEL_REPRESENTATION,
            VR::US,
            PrimitiveValue::from(0_u16),
        ),
        DataElement::new(tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1_u16)),
        DataElement::new(
            tags::PHOTOMETRIC_INTERPRETATION,
            VR::CS,
            PrimitiveValue::from("MONOCHROME2"),
        ),
        DataElement::new(tags::NUMBER_OF_FRAMES, VR::IS, PrimitiveValue::from("3")),
        DataElement::new(tags::WINDOW_CENTER, VR::DS, PrimitiveValue::from("750")),
        DataElement::new(tags::WINDOW_WIDTH, VR::DS, PrimitiveValue::from("1500")),
        DataElement::new(tags::PIXEL_DATA, VR::OW, PrimitiveValue::from(pixel_bytes)),
    ]);
    obj.put(DataElement::new(
        tags::RESCALE_SLOPE,
        VR::DS,
        PrimitiveValue::from("1"),
    ));
    obj.put(DataElement::new(
        tags::RESCALE_INTERCEPT,
        VR::DS,
        PrimitiveValue::from("0"),
    ));

    let file_object = obj
        .with_meta(
            FileMetaTableBuilder::new()
                .transfer_syntax(uids::EXPLICIT_VR_LITTLE_ENDIAN)
                .media_storage_sop_class_uid(uids::CT_IMAGE_STORAGE)
                .media_storage_sop_instance_uid("2.25.2000001"),
        )
        .expect("build uncompressed fixture meta");

    file_object
        .write_to_file(path)
        .expect("write uncompressed golden fixture");
}

fn write_jpeg_single_frame(path: &Path) {
    write_jpeg_fixture(
        path,
        "2.25.2000002",
        "GOLDEN-JPEG",
        vec![Fragments::new(grayscale_jpeg_fragment_16x16(24), 0)],
    );
}

fn write_large_jpeg_single_frame(path: &Path) {
    let columns = 3328_u16;
    let rows = 2560_u16;
    let fragment = large_grayscale_jpeg_fragment(columns.into(), rows.into());

    let mut obj = InMemDicomObject::from_element_iter([
        DataElement::new(
            tags::SOP_CLASS_UID,
            VR::UI,
            uids::DIGITAL_MAMMOGRAPHY_X_RAY_IMAGE_STORAGE_FOR_PRESENTATION,
        ),
        DataElement::new(tags::SOP_INSTANCE_UID, VR::UI, "2.25.2000005"),
        DataElement::new(
            tags::PATIENT_ID,
            VR::LO,
            PrimitiveValue::from("GOLDEN-JPEG-LARGE"),
        ),
        DataElement::new(tags::MODALITY, VR::CS, PrimitiveValue::from("MG")),
        DataElement::new(tags::STUDY_DATE, VR::DA, PrimitiveValue::from("20260608")),
        DataElement::new(tags::ROWS, VR::US, PrimitiveValue::from(rows)),
        DataElement::new(tags::COLUMNS, VR::US, PrimitiveValue::from(columns)),
        DataElement::new(tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(8_u16)),
        DataElement::new(tags::BITS_STORED, VR::US, PrimitiveValue::from(8_u16)),
        DataElement::new(tags::HIGH_BIT, VR::US, PrimitiveValue::from(7_u16)),
        DataElement::new(
            tags::PIXEL_REPRESENTATION,
            VR::US,
            PrimitiveValue::from(0_u16),
        ),
        DataElement::new(tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1_u16)),
        DataElement::new(
            tags::PHOTOMETRIC_INTERPRETATION,
            VR::CS,
            PrimitiveValue::from("MONOCHROME2"),
        ),
        DataElement::new(tags::NUMBER_OF_FRAMES, VR::IS, PrimitiveValue::from("1")),
        DataElement::new(tags::WINDOW_CENTER, VR::DS, PrimitiveValue::from("128")),
        DataElement::new(tags::WINDOW_WIDTH, VR::DS, PrimitiveValue::from("256")),
    ]);

    let pixel_sequence: PixelFragmentSequence<Vec<u8>> =
        vec![Fragments::new(fragment, 0)].into();
    obj.put(DataElement::new(tags::PIXEL_DATA, VR::OB, pixel_sequence));

    let file_object = obj
        .with_meta(
            FileMetaTableBuilder::new()
                .transfer_syntax(uids::JPEG_BASELINE8_BIT)
                .media_storage_sop_class_uid(
                    uids::DIGITAL_MAMMOGRAPHY_X_RAY_IMAGE_STORAGE_FOR_PRESENTATION,
                )
                .media_storage_sop_instance_uid("2.25.2000005"),
        )
        .expect("build large JPEG fixture meta");

    file_object
        .write_to_file(path)
        .expect("write large JPEG golden fixture");
}

fn write_jpeg_multiframe_with_bot(path: &Path) {
    write_jpeg_fixture(
        path,
        "2.25.2000003",
        "GOLDEN-JPEG-MF",
        vec![
            Fragments::new(grayscale_jpeg_fragment_16x16(15), 0),
            Fragments::new(grayscale_jpeg_fragment_16x16(90), 0),
            Fragments::new(grayscale_jpeg_fragment_16x16(165), 0),
        ],
    );
}

fn write_jpeg_fixture(
    path: &Path,
    sop_instance_uid: &str,
    patient_id: &str,
    frames: Vec<Fragments>,
) {
    let frame_count = frames.len().max(1);
    let mut obj = InMemDicomObject::from_element_iter([
        DataElement::new(
            tags::SOP_CLASS_UID,
            VR::UI,
            uids::DIGITAL_MAMMOGRAPHY_X_RAY_IMAGE_STORAGE_FOR_PRESENTATION,
        ),
        DataElement::new(tags::SOP_INSTANCE_UID, VR::UI, sop_instance_uid),
        DataElement::new(tags::PATIENT_ID, VR::LO, PrimitiveValue::from(patient_id)),
        DataElement::new(tags::MODALITY, VR::CS, PrimitiveValue::from("MG")),
        DataElement::new(tags::STUDY_DATE, VR::DA, PrimitiveValue::from("20260608")),
        DataElement::new(tags::ROWS, VR::US, PrimitiveValue::from(16_u16)),
        DataElement::new(tags::COLUMNS, VR::US, PrimitiveValue::from(16_u16)),
        DataElement::new(tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(8_u16)),
        DataElement::new(tags::BITS_STORED, VR::US, PrimitiveValue::from(8_u16)),
        DataElement::new(tags::HIGH_BIT, VR::US, PrimitiveValue::from(7_u16)),
        DataElement::new(
            tags::PIXEL_REPRESENTATION,
            VR::US,
            PrimitiveValue::from(0_u16),
        ),
        DataElement::new(tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1_u16)),
        DataElement::new(
            tags::PHOTOMETRIC_INTERPRETATION,
            VR::CS,
            PrimitiveValue::from("MONOCHROME2"),
        ),
        DataElement::new(
            tags::NUMBER_OF_FRAMES,
            VR::IS,
            PrimitiveValue::from(frame_count.to_string()),
        ),
    ]);

    let pixel_sequence: PixelFragmentSequence<Vec<u8>> = frames.into();
    obj.put(DataElement::new(tags::PIXEL_DATA, VR::OB, pixel_sequence));

    let file_object = obj
        .with_meta(
            FileMetaTableBuilder::new()
                .transfer_syntax(uids::JPEG_BASELINE8_BIT)
                .media_storage_sop_class_uid(
                    uids::DIGITAL_MAMMOGRAPHY_X_RAY_IMAGE_STORAGE_FOR_PRESENTATION,
                )
                .media_storage_sop_instance_uid(sop_instance_uid),
        )
        .expect("build JPEG fixture meta");

    file_object
        .write_to_file(path)
        .expect("write JPEG golden fixture");
}

fn write_sr_without_pixels(path: &Path) {
    let obj = InMemDicomObject::from_element_iter([
        DataElement::new(tags::SOP_CLASS_UID, VR::UI, uids::BASIC_TEXT_SR_STORAGE),
        DataElement::new(tags::SOP_INSTANCE_UID, VR::UI, "2.25.2000004"),
        DataElement::new(tags::PATIENT_ID, VR::LO, PrimitiveValue::from("GOLDEN-SR")),
        DataElement::new(tags::MODALITY, VR::CS, PrimitiveValue::from("SR")),
        DataElement::new(tags::STUDY_DATE, VR::DA, PrimitiveValue::from("20260608")),
        DataElement::new(
            tags::SERIES_DESCRIPTION,
            VR::LO,
            PrimitiveValue::from("No pixel fixture"),
        ),
        DataElement::new(tags::INSTANCE_NUMBER, VR::IS, PrimitiveValue::from("1")),
    ]);

    let file_object = obj
        .with_meta(
            FileMetaTableBuilder::new()
                .transfer_syntax(uids::EXPLICIT_VR_LITTLE_ENDIAN)
                .media_storage_sop_class_uid(uids::BASIC_TEXT_SR_STORAGE)
                .media_storage_sop_instance_uid("2.25.2000004"),
        )
        .expect("build SR fixture meta");

    file_object
        .write_to_file(path)
        .expect("write SR golden fixture");
}

fn grayscale_jpeg_fragment_16x16(seed: u8) -> Vec<u8> {
    let image = GrayImage::from_fn(16, 16, |x, y| {
        let value = seed
            .wrapping_add((x as u8).wrapping_mul(7))
            .wrapping_add((y as u8).wrapping_mul(11));
        Luma([value])
    });
    let mut encoded = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 90);
    encoder
        .encode_image(&image)
        .expect("encode grayscale jpeg fixture");
    encoded
}

fn large_grayscale_jpeg_fragment(width: u32, height: u32) -> Vec<u8> {
    let center_x = width as i32 / 2;
    let center_y = height as i32 / 2;
    let image = GrayImage::from_fn(width, height, |x, y| {
        let x = x as i32;
        let y = y as i32;
        let dx = x - center_x;
        let dy = y - center_y;
        let distance_sq = dx * dx + dy * dy;
        let value = if dx.abs() < 8 || dy.abs() < 8 {
            210
        } else if distance_sq < 180_i32.pow(2) {
            170
        } else if x < center_x && y < center_y {
            72
        } else if x >= center_x && y < center_y {
            96
        } else if x < center_x {
            120
        } else {
            144
        };
        Luma([value])
    });
    let mut encoded = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 80);
    encoder
        .encode_image(&image)
        .expect("encode large grayscale jpeg fixture");
    encoded
}
