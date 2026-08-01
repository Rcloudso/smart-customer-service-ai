import unittest

from contract_mapper import has_expected_signature, map_ppstructure_results


class ContractMapperTest(unittest.TestCase):
    def test_validates_source_signatures(self) -> None:
        self.assertTrue(has_expected_signature("application/pdf", b"%PDF-1.7"))
        self.assertTrue(
            has_expected_signature("image/png", b"\x89PNG\r\n\x1a\npayload")
        )
        self.assertTrue(has_expected_signature("image/jpeg", b"\xff\xd8\xffpayload"))
        self.assertTrue(
            has_expected_signature("image/webp", b"RIFF\x00\x00\x00\x00WEBPpayload")
        )
        self.assertFalse(has_expected_signature("image/png", b"%PDF-1.7"))

    def test_maps_heading_table_and_fallback_lines(self) -> None:
        result = map_ppstructure_results([
            {
                "page_index": 0,
                "parsing_res_list": [
                    {
                        "sub_label": "title_text",
                        "block_content": "Refund policy",
                        "block_bbox": [10, 20, 200, 50],
                        "score": 0.98,
                    },
                    {
                        "block_label": "table",
                        "block_content": "",
                        "block_bbox": [[10, 60], [300, 60], [300, 160], [10, 160]],
                    },
                ],
                "table_res_list": [
                    {
                        "pred_html": (
                            "<table><tr><th>Method</th><th>Days</th></tr>"
                            "<tr><td rowspan='2'>Card</td><td>7</td></tr>"
                            "<tr><td>10</td></tr></table>"
                        ),
                    }
                ],
            },
            {
                "page_index": 1,
                "overall_ocr_res": {
                    "rec_texts": ["Provide an order number"],
                    "rec_scores": [0.55],
                    "rec_boxes": [[12, 18, 320, 48]],
                },
            },
            {
                "page_index": 2,
            },
        ], "3.0.0", 25)

        self.assertEqual(result["metrics"]["pageCount"], 3)
        self.assertEqual(result["metrics"]["blockCount"], 3)
        self.assertEqual(
            [block["kind"] for block in result["blocks"]],
            ["heading", "table", "paragraph"],
        )
        self.assertEqual(result["blocks"][1]["rowCount"], 3)
        self.assertEqual(result["blocks"][1]["columnCount"], 2)
        self.assertEqual(result["blocks"][1]["cells"][2]["rowSpan"], 2)
        self.assertEqual(result["blocks"][1]["cells"][4]["columnIndex"], 1)
        self.assertEqual(result["blocks"][1]["cells"][4]["text"], "10")
        self.assertEqual(result["blocks"][2]["pageNumber"], 2)
        self.assertEqual(result["warnings"][0]["code"], "ocr_empty_page")
        self.assertEqual(result["warnings"][1]["code"], "ocr_low_confidence")
        self.assertEqual(result["warnings"][1]["blockIds"], ["block-000003"])

    def test_rejects_pathological_table_span(self) -> None:
        with self.assertRaisesRegex(ValueError, "Table span"):
            map_ppstructure_results([{
                "page_index": 0,
                "parsing_res_list": [{
                    "block_label": "table",
                    "block_content": "",
                }],
                "table_res_list": [{
                    "pred_html": (
                        "<table><tr><td rowspan='1000' colspan='1000'>"
                        "oversized</td></tr></table>"
                    ),
                }],
            }], "3.0.3", 1)

    def test_rejects_excessive_page_results(self) -> None:
        with self.assertRaisesRegex(ValueError, "page limit"):
            map_ppstructure_results(
                [{"page_index": index} for index in range(101)],
                "3.0.3",
                1,
            )


if __name__ == "__main__":
    unittest.main()
