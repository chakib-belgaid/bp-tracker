---
license: mit
pretty_name: Blood-pressure monitor seven-segment displays
task_categories:
- image-classification
- image-to-text
tags:
- seven-segment
- lcd
- ocr
- digits
- blood-pressure
size_categories:
- n<1K
configs:
- config_name: readings
  data_files:
  - split: dev
    path: readings/dev/*
  - split: test
    path: readings/test/*
- config_name: digits
  data_files:
  - split: dev
    path: digits/dev/*
  - split: test
    path: digits/test/*
---

# Blood-pressure monitor seven-segment displays

Real photos of a home blood-pressure monitor's backlit LCD, labelled with systolic, diastolic and
pulse, plus the individual digits cut out of them. This is the real-world test set of
[BP Log](https://github.com/chakib-belgaid/bp-tracker), an offline app that reads the display
from a phone photo with a 10k-parameter CNN trained **only on synthetic digits**.

The data is meant for **testing** readers of seven-segment displays (or for fine-tuning). It is
small, and it comes from a single monitor.

## Configs

### `readings`: one image per measurement

| column | |
|---|---|
| `image` | the display: 53 app scans (the cropped display, 160 px) and 2 full phone photos |
| `systolic`, `diastolic`, `pulse` | values confirmed by the user (mmHg, mmHg, beats/min) |
| `reading_id` | `reading_001` … links digits to their reading |
| `image_kind`, `width`, `height` | `app scan (display crop, 160 px)` or `full photo` |

The backlight is green, yellow or beige depending on the reading. Some photos have glare, and
the pulse is often much fainter than the other numbers.

### `digits`: one image per digit

| column | |
|---|---|
| `image` | 24×32 grayscale **ink map**: 0 = background, 255 = darkest ink |
| `label` | digit 0–9 |
| `reading_id`, `row`, `position` | which reading, which number (systolic / diastolic / pulse), which digit from the left |

Each crop is a digit cell found by the app's parser, padded by 15% on every side, then resized to
24×32. The pixel values are each pixel's darkness relative to its local background, so the
backlight colour doesn't matter. Digits come only from rows where the parser found the right
number of digit cells (161 of 165 rows).

## Splits

Split **by photo** (never mixing digits of one photo), with a fixed hash of each photo's id:

| config | dev | test |
|---|---|---|
| readings | 29 | 26 |
| digits | 201 | 187 |

In the BP Log project, *dev* was looked at while tuning the synthetic generator; *test* was used
only for the final numbers.

## Baselines

From the BP Log project (same splits):

| digits | 7-segment rules | DigitNet (10k-param CNN, synthetic training only) |
|---|---|---|
| dev | 96.0% | 98.5% |
| test | 95.7% | **99.5%** |

For whole readings (all three values right, all 55 photos), the full parser reaches 85% with the
7-segment rules and 91% with DigitNet. Most remaining errors are in finding the rows, not in
reading the digits.

## How it was collected

- One upper-arm home blood-pressure monitor, one person, photographed with an Android phone over
  about two weeks in October 2026.
- App scans are the 160 px display crops the app stored. The two full photos are originals.
- Labels are the values the user confirmed in the app. Two typos were corrected after checking
  the photos (pulse 74 → 94, systolic 138 → 130).

## Privacy

Published with the consent of the person measured. File names, timestamps and image metadata were
removed; `reading_id`s follow the order of the measurements and reveal nothing else. Some clock
digits are visible on the display itself.

## Limitations

- **One monitor, one person:** fonts, layout and value ranges are narrow.
- **Small:** 388 digits, so one error is about 0.5%, and digits 4, 5 and 6 are rare.
- **Low resolution:** most readings are 160 px display crops.
- Not for medical use.

## Use

```python
from datasets import load_dataset

readings = load_dataset("chakibmed/bp-monitor-seven-segment", "readings")
digits = load_dataset("chakibmed/bp-monitor-seven-segment", "digits")
print(readings["test"][0]["systolic"], digits["test"][0]["label"])
```

## License

MIT. Code, the generator and the model: <https://github.com/chakib-belgaid/bp-tracker>.
