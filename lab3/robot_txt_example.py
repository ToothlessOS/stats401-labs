from urllib.robotparser import RobotFileParser

rp = RobotFileParser()
rp.set_url("https://www.toothlessos.xyz/robots.txt")
rp.read()

allowed = rp.can_fetch(
    "STATS401-Class-Exercise/1.0", "https://www.toothlessos.xyz/wp-admin/"
)

print("Allowed:", allowed)
