#!/opt/yamusic/yt-env/bin/python3
"""Pinned yt-dlp 2026.10.26 audio-only launcher; artwork comes from Deezer.
SoundCloud's original-artwork HEAD probe can stall resolution for many seconds.
Skip only that unused artwork variant, preserving media validation and access.
"""
from yt_dlp.extractor.soundcloud import SoundcloudBaseIE
SoundcloudBaseIE._ARTWORK_MAP = {key: value for key, value in SoundcloudBaseIE._ARTWORK_MAP.items() if key != 'original'}
from yt_dlp import main
main()
