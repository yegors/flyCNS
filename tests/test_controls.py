import json
import unittest
from unittest.mock import Mock
from flylab.server import Lab

class PausedControlTests(unittest.TestCase):
    def make_lab(self):
        lab = object.__new__(Lab)
        lab.playing = True
        lab.drives = {'sugar':150}
        lab.fix_on = True
        lab.retina_on = True
        lab.sim = Mock()
        lab.push = Mock()
        return lab

    def state(self, lab):
        args, kwargs = lab.push.call_args
        self.assertTrue(kwargs['text'])
        return json.loads(args[0])

    def test_pause_and_resume_acknowledge_without_simulation_ticks(self):
        lab = self.make_lab()
        lab.handle({'cmd':'pause'})
        self.assertFalse(self.state(lab)['playing'])
        lab.handle({'cmd':'play'})
        self.assertTrue(self.state(lab)['playing'])
        lab.sim.tick.assert_not_called()

    def test_clear_while_paused_updates_active_signals(self):
        lab = self.make_lab()
        lab.playing = False
        lab.handle({'cmd':'clear'})
        self.assertEqual(self.state(lab)['drives'], {})
        self.assertFalse(self.state(lab)['playing'])
        self.assertFalse(lab.retina_on)
        lab.sim.clear_drive.assert_called_once()

if __name__ == '__main__':
    unittest.main()
