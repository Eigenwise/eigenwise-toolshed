"""haiku-jar: a small jar that keeps haiku and draws one back out at random.

Four tiny pieces, each its own file:

    haiku.py     the Haiku itself, three lines and a loose count of syllables
    jar.py       the Jar that holds them and gives one back
    storage.py   reading the jar from, and writing it to, a JSON file
    cli.py       the command line that ties the knot
"""

from haiku_jar.haiku import Haiku
from haiku_jar.jar import EmptyJarError, Jar

__version__ = "0.1.0"

__all__ = ["Haiku", "Jar", "EmptyJarError", "__version__"]
