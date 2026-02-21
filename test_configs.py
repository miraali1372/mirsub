import requests

# New source URL for vless configuration
SOURCE_URL = 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt'

def load_config():
    response = requests.get(SOURCE_URL)
    if response.status_code == 200:
        return response.text.splitlines()
    else:
        raise Exception('Failed to load config: {}'.format(response.status_code))

# Example function to test configuration

def test_config():
    try:
        config = load_config()
        # Perform some basic validation on the config
        assert config, "Configuration is empty"
        # Additional checks can be added here
        print('Configuration loaded and validated successfully.')
    except Exception as e:
        print('Error during config testing:', e)

if __name__ == '__main__':
    test_config()