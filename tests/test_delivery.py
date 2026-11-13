import unittest

from worker.delivery import delivery


class DeliveryTests(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual(delivery({}, "af_heart", 1), ("af_heart", 1))
        self.assertAlmostEqual(delivery({"calm": .3, "reassuring": .7, "excited": .5}, "bf_emma", 1)[1], .998)
        self.assertEqual(delivery({"sad": 1, "calm": 1}, "am_adam", .7)[1], .7)
        self.assertEqual(delivery({"excited": 1}, "bm_george", 1.3)[1], 1.3)
        self.assertEqual(delivery({"sad": True, "calm": float('nan'), "excited": 2, "unknown": 1}, "af_heart", 1)[1], 1)

    def test_invalid_config(self):
        for voice, speed in [("xx_voice", 1), ("af_", 1), ("af_heart", True),
                             ("af_heart", float('inf')), ("af_heart", .6)]:
            with self.subTest(voice=voice, speed=speed), self.assertRaises(ValueError):
                delivery({}, voice, speed)
        with self.assertRaises(ValueError):
            delivery(None, "af_heart", 1)
