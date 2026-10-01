from html.parser import HTMLParser
from pathlib import Path
import unittest


class VideoPreloadParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.preload_values = []

    def handle_starttag(self, tag, attrs):
        if tag == "video":
            self.preload_values.append(dict(attrs).get("preload"))


class VideoPreloadTest(unittest.TestCase):
    def test_videos_do_not_preload_media_before_playback(self):
        page = Path(__file__).resolve().parents[1] / "index.html"
        parser = VideoPreloadParser()
        parser.feed(page.read_text(encoding="utf-8"))

        self.assertTrue(parser.preload_values, "Expected video elements on the home page")
        self.assertEqual(["none"] * len(parser.preload_values), parser.preload_values)


if __name__ == "__main__":
    unittest.main()
