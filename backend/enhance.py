#!/usr/bin/env python3.11
"""
enhance.py  –  Offline AI Script Cleanup for VoiceAI (Tauri)
Uses NLTK for sentence/token processing — no LLM, no internet after first run.

Called by Rust as:
    python3.11 enhance.py <mode> <style> <text>

Arguments:
    mode   : "punctuation" | "style" | "both"
    style  : "none" | "news_anchor" | "narrator" | "storyteller" | "podcast_host" | "documentary"
    text   : raw script text

Outputs the enhanced text to stdout.
"""

import sys
import os
import re

# ── Bootstrap NLTK data path ──────────────────────────────────────────────────
try:
    import nltk
    NLTK_DATA = os.path.expanduser("~/nltk_data")
    if NLTK_DATA not in nltk.data.path:
        nltk.data.path.insert(0, NLTK_DATA)

    def ensure_nltk():
        for pkg in ["punkt", "punkt_tab", "averaged_perceptron_tagger", "averaged_perceptron_tagger_eng"]:
            try:
                nltk.data.find(f"tokenizers/{pkg}" if "punkt" in pkg else f"taggers/{pkg}")
            except LookupError:
                nltk.download(pkg, quiet=True, download_dir=NLTK_DATA)

    ensure_nltk()
    from nltk.tokenize import sent_tokenize as _nltk_sent_tokenize
    def sent_tokenize(text):
        return _nltk_sent_tokenize(text)

except Exception:
    # Fallback: simple regex sentence splitter (no NLTK needed)
    def sent_tokenize(text):
        parts = re.split(r'(?<=[.!?…])\s+(?=[A-Z"\'])', text.strip())
        return [p.strip() for p in parts if p.strip()] or [text.strip()]

# ── Args ──────────────────────────────────────────────────────────────────────
if len(sys.argv) < 4:
    print("Usage: enhance.py <mode> <style> <text>")
    sys.exit(1)

mode  = sys.argv[1]
style = sys.argv[2]
text  = sys.argv[3]

if not text.strip():
    print(text)
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# SHARED UTILITIES
# ─────────────────────────────────────────────────────────────────────────────

def fix_sentence_endings(s: str) -> str:
    s = s.strip()
    if s and s[-1] not in ".!?…":
        s += "."
    return s

def fix_spacing(text: str) -> str:
    text = re.sub(r' +', ' ', text)
    text = re.sub(r' ([,.])', r'\1', text)
    text = re.sub(r'\.{4,}', '...', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' —', ' —', text)   # normalise em-dash spacing
    text = re.sub(r'— ', '— ', text)
    return text.strip()

def split_at_conjunction(sent: str, max_words: int) -> list:
    """Split a long sentence at the first conjunction past the midpoint."""
    words = sent.split()
    if len(words) <= max_words:
        return [sent]
    mid = max(max_words // 2, 5)
    conjunctions = {'and', 'but', 'however', 'while', 'although', 'though',
                    'yet', 'so', 'because', 'since', 'unless', 'until', 'whereas'}
    for i in range(mid, len(words) - 2):
        if words[i].lower().rstrip(',') in conjunctions:
            part1 = ' '.join(words[:i])
            part2 = words[i].capitalize() + ' ' + ' '.join(words[i+1:])
            return [fix_sentence_endings(part1), part2]
    # No conjunction found — split at comma nearest midpoint
    for i in range(mid, len(words) - 2):
        if words[i-1].endswith(','):
            part1 = ' '.join(words[:i])
            part2 = ' '.join(words[i:])
            return [fix_sentence_endings(part1), part2]
    # Hard split at max_words
    part1 = ' '.join(words[:max_words])
    part2 = ' '.join(words[max_words:])
    return [fix_sentence_endings(part1), part2]

def add_clause_pause(sent: str, marker: str) -> str:
    """Insert a pacing marker before mid-sentence conjunctions."""
    return re.sub(
        r'([a-zA-Z,])(\s+)(and|but|yet|so|however|although|though|while|whereas)(\s+)',
        lambda m: m.group(1) + m.group(2) + marker + m.group(3) + m.group(4),
        sent, count=1, flags=re.IGNORECASE
    )

# ─────────────────────────────────────────────────────────────────────────────
# PUNCTUATION ENGINE
# ─────────────────────────────────────────────────────────────────────────────

PAUSE_STARTERS = {
    "however", "therefore", "moreover", "furthermore", "meanwhile",
    "nonetheless", "nevertheless", "consequently", "additionally",
    "in fact", "in addition", "as a result", "on the other hand",
    "for example", "for instance", "in other words", "that said",
    "of course", "after all", "in contrast", "on the contrary",
    "at the same time", "first", "second", "third", "finally",
    "next", "then", "also", "besides", "instead", "otherwise",
    "indeed", "certainly", "naturally", "clearly", "obviously",
    "well", "now", "so", "but", "and yet",
}

CONJUNCTION_PAUSE = {"but", "yet", "so", "for", "nor"}

def insert_pause_commas(sentence: str) -> str:
    s = sentence
    for starter in sorted(PAUSE_STARTERS, key=len, reverse=True):
        pattern = re.compile(r'^(' + re.escape(starter) + r')(\s+)([a-zA-Z])', re.IGNORECASE)
        s = pattern.sub(lambda m: m.group(1) + "," + m.group(2) + m.group(3), s, count=1)
    for conj in CONJUNCTION_PAUSE:
        pattern = re.compile(r'([a-zA-Z])(\s+)(' + re.escape(conj) + r')(\s+)([a-zA-Z])', re.IGNORECASE)
        s = pattern.sub(lambda m: m.group(1) + "," + m.group(2) + m.group(3) + m.group(4) + m.group(5), s)
    intro_pattern = re.compile(
        r'^(When|If|Although|Though|Because|Since|While|After|Before|Once|Unless|Until|As)\b(.{10,60}?),?\s+([A-Z])',
    )
    def add_intro_comma(m):
        clause = m.group(1) + m.group(2)
        if not clause.rstrip().endswith(","):
            clause = clause.rstrip() + ","
        return clause + " " + m.group(3)
    s = intro_pattern.sub(add_intro_comma, s, count=1)
    s = re.sub(r',\s*,', ',', s)
    return s

def apply_punctuation(text: str) -> str:
    paragraphs = text.split('\n\n')
    result_paragraphs = []
    for para in paragraphs:
        if not para.strip():
            result_paragraphs.append(para)
            continue
        sentences = sent_tokenize(para.strip())
        enhanced = [fix_sentence_endings(insert_pause_commas(s)) for s in sentences]
        result_paragraphs.append(" ".join(enhanced))
    return fix_spacing("\n\n".join(result_paragraphs))


# ─────────────────────────────────────────────────────────────────────────────
# STYLE ENGINE
# Each function transforms ANY text structurally, not just keyword-triggered.
# ─────────────────────────────────────────────────────────────────────────────

def style_news_anchor(text: str) -> str:
    """
    News Anchor: authoritative, concise, direct.
    - Removes filler words
    - Splits long sentences (>22 words) into crisp segments
    - Ensures punchy sentence endings
    """
    FILLERS = re.compile(
        r'\b(you know|kind of|sort of|basically|literally|actually|honestly|'
        r'like really|i mean|you see|right\?|okay so|um+|uh+|well,?\s*'
        r'|just|simply|really|very|quite|pretty much)\b',
        re.IGNORECASE
    )

    paragraphs = text.split('\n\n')
    result = []
    for para in paragraphs:
        sentences = sent_tokenize(para.strip())
        out = []
        for sent in sentences:
            sent = FILLERS.sub('', sent)
            sent = re.sub(r' +', ' ', sent).strip()
            if not sent:
                continue
            # Split sentences over 22 words at natural break points
            parts = split_at_conjunction(sent, max_words=22)
            for part in parts:
                out.append(fix_sentence_endings(part))
        result.append(" ".join(out))
    return fix_spacing("\n\n".join(result))


def style_narrator(text: str) -> str:
    """
    Narrator: warm, flowing, measured.
    - Adds ellipsis pauses before climactic transitions
    - Adds gentle comma rhythm at mid-sentence conjunctions
    - Smooths paragraph transitions
    """
    CLIMAX = re.compile(
        r'\b(suddenly|but then|and then|at last|finally|in the end|'
        r'until now|at that moment|in that instant|only to find|'
        r'little did|to discover|what followed|as it turned out|'
        r'before long|all at once|without warning)\b',
        re.IGNORECASE
    )

    paragraphs = text.split('\n\n')
    result = []
    for para in paragraphs:
        sentences = sent_tokenize(para.strip())
        out = []
        for sent in sentences:
            # Add ellipsis before climax words
            sent = CLIMAX.sub(lambda m: "... " + m.group(0), sent)
            # Add comma rhythm at mid-sentence conjunctions for longer sentences
            if len(sent.split()) > 12:
                sent = add_clause_pause(sent, "")
            sent = re.sub(r'\.\.\. \.\.\.', '...', sent)
            out.append(fix_sentence_endings(sent))
        result.append(" ".join(out))
    return fix_spacing("\n\n".join(result))


def style_storyteller(text: str) -> str:
    """
    Storyteller: vivid, dramatic, suspenseful.
    - Inserts em-dashes at mid-sentence clause breaks for drama
    - Adds suspense ellipsis at sentence ends of short punchy sentences
    - Adds pause markers before reveal words
    """
    REVEAL = re.compile(
        r'\b(and there it was|and then|but suddenly|only to|and yet|'
        r'little did|no one knew|what happened next|the truth was|it was then|'
        r'to everyone|all of a sudden|without warning|in that moment)\b',
        re.IGNORECASE
    )

    paragraphs = text.split('\n\n')
    result = []
    for para in paragraphs:
        sentences = sent_tokenize(para.strip())
        out = []
        for sent in sentences:
            # Add em-dash before reveal phrases
            sent = REVEAL.sub(lambda m: "— " + m.group(0), sent, count=1)
            words = sent.split()
            # Add em-dash at mid-sentence clause break for long sentences
            if len(words) > 15:
                sent = add_clause_pause(sent, "— ")
            # Short punchy sentences get suspense ellipsis instead of period
            elif len(words) <= 8 and sent.endswith('.'):
                sent = sent[:-1] + "..."
            out.append(fix_sentence_endings(sent))
        result.append(" ".join(out))
    return fix_spacing("\n\n".join(result))


def style_podcast_host(text: str) -> str:
    """
    Podcast Host: relaxed, conversational, natural.
    - Replaces formal vocabulary with casual alternatives
    - Breaks very long sentences into short, punchy ones
    - Adds conversational connectors between sentences
    """
    FORMAL_TO_CASUAL = [
        (re.compile(r'\bIn conclusion\b',               re.I), "So, to wrap things up"),
        (re.compile(r'\bFurthermore\b',                 re.I), "And also"),
        (re.compile(r'\bMoreover\b',                    re.I), "On top of that"),
        (re.compile(r'\bNevertheless\b',                re.I), "Still though"),
        (re.compile(r'\bConsequently\b',                re.I), "So"),
        (re.compile(r'\bIt is important to note\b',     re.I), "Here's the thing"),
        (re.compile(r'\bOne must consider\b',           re.I), "You've got to think about"),
        (re.compile(r'\bIt can be observed\b',          re.I), "You can see"),
        (re.compile(r'\bIn addition\b',                 re.I), "Plus"),
        (re.compile(r'\bHowever\b',                     re.I), "But"),
        (re.compile(r'\bTherefore\b',                   re.I), "So"),
        (re.compile(r'\butilize\b',                     re.I), "use"),
        (re.compile(r'\bpurchase\b',                    re.I), "buy"),
        (re.compile(r'\bcommence\b',                    re.I), "start"),
        (re.compile(r'\bterminate\b',                   re.I), "end"),
        (re.compile(r'\bdemonstrate\b',                 re.I), "show"),
        (re.compile(r'\brequire\b',                     re.I), "need"),
        (re.compile(r'\battempt\b',                     re.I), "try"),
        (re.compile(r'\bsufficient\b',                  re.I), "enough"),
        (re.compile(r'\bnumerous\b',                    re.I), "a lot of"),
    ]
    # Casual sentence starters to inject at sentence boundaries
    STARTERS = ["So, ", "Now, ", "Here's the thing — ", "And ", "Look, ", "Right, "]

    paragraphs = text.split('\n\n')
    result = []
    for para in paragraphs:
        out = para
        for pattern, replacement in FORMAL_TO_CASUAL:
            out = pattern.sub(replacement, out)
        sentences = sent_tokenize(out.strip())
        out_sents = []
        for i, sent in enumerate(sentences):
            # Split long sentences casually
            parts = split_at_conjunction(sent, max_words=25)
            for j, part in enumerate(parts):
                # Add a casual starter to every 3rd sentence
                if i > 0 and j == 0 and i % 3 == 0 and not re.match(r'\b(so|now|here|look|right|and|but|plus)\b', part, re.I):
                    part = STARTERS[i % len(STARTERS)] + part[0].lower() + part[1:]
                out_sents.append(fix_sentence_endings(part))
        result.append(" ".join(out_sents))
    return fix_spacing("\n\n".join(result))


def style_documentary(text: str) -> str:
    """
    Documentary: cinematic, measured, Attenborough-like gravitas.
    - Adds em-dash pauses after long opening clauses of sentences
    - Inserts deliberate pauses before key statements
    - Adds gravity markers around weighty concepts
    """
    WEIGHT_WORDS = re.compile(
        r'\b(for millions of years|across the ages|in the vast|throughout history|'
        r'against all odds|in the natural world|over time|slowly but surely|'
        r'remarkably|extraordinary|astonishing|ancient|profound|remarkable|'
        r'beneath the surface|hidden from view|across the world|'
        r'against the odds|in an instant|over millennia)\b',
        re.IGNORECASE
    )

    paragraphs = text.split('\n\n')
    result = []
    for para in paragraphs:
        if not para.strip():
            result.append(para)
            continue
        sentences = sent_tokenize(para.strip())
        out = []
        for i, sent in enumerate(sentences):
            words = sent.split()
            # Add em-dash gravity pause after the first long clause
            if len(words) > 10:
                # Find first comma or conjunction past word 6
                for k in range(6, min(len(words), 16)):
                    if words[k-1].endswith(',') or words[k].lower() in ('and', 'but', 'yet', 'however'):
                        first_clause = ' '.join(words[:k]).rstrip(',')
                        rest = ' '.join(words[k:])
                        if words[k].lower() in ('and', 'but', 'yet', 'however'):
                            rest = words[k].capitalize() + ' ' + ' '.join(words[k+1:])
                        sent = first_clause + " — " + rest
                        break
            # Add em-dash pause after weighty words
            sent = WEIGHT_WORDS.sub(lambda m: m.group(0) + " —", sent, count=1)
            sent = re.sub(r' —\s*—', ' —', sent)
            out.append(fix_sentence_endings(sent))
        result.append(" ".join(out))
    return fix_spacing("\n\n".join(result))


STYLE_FN = {
    "news_anchor":  style_news_anchor,
    "narrator":     style_narrator,
    "storyteller":  style_storyteller,
    "podcast_host": style_podcast_host,
    "documentary":  style_documentary,
}


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

output = text

try:
    if mode in ("punctuation", "both"):
        output = apply_punctuation(output)

    if mode in ("style", "both") and style in STYLE_FN:
        output = STYLE_FN[style](output)
        output = fix_spacing(output)

    print(output)
    sys.exit(0)

except Exception as e:
    import traceback
    sys.stderr.write(f"Enhance error: {e}\n{traceback.format_exc()}\n")
    sys.exit(1)
